/**
 * ChatSession — unified state machine for chat worker lifecycle.
 *
 * Replaces worker-manager.ts + bridge-proxy.ts. One class manages:
 * container lifecycle + bridge WS + frontend fan-out + event buffering + DB persistence.
 *
 * States: IDLE → STARTING → READY → ACTIVE → RECOVERING → STARTING → ...
 */

import { join } from "node:path";
import { WebSocket } from "ws";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getCredentialById, getDefaultOrFirstAvailableCredential, listCredentials } from "../settings/storage.js";
import { ChatCredentialUnavailableError } from "./errors.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { credentialToWorkerEnv } from "../settings/credential-env.js";
import { getSession, appendMessage } from "./storage.js";
import { getUserById } from "../auth/storage.js";
import { maybeGenerateTitle } from "./title-generation.js";
import { loadConfig } from "../../infra/config.js";
import { notify } from "../notifications/index.js";
import { logger } from "../../infra/logger.js";

type State = "idle" | "starting" | "ready" | "active" | "recovering";

const EVENT_BUFFER_SIZE = 100;

interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

// ─── Registry ───

const sessions = new Map<string, ChatSession>();

export function getOrCreateSession(sessionId: string): ChatSession {
  let s = sessions.get(sessionId);
  if (!s) {
    s = new ChatSession(sessionId);
    sessions.set(sessionId, s);
  }
  return s;
}

/** Lookup only — never creates. Used by authenticated frontend WS attach. */
export function getExistingSession(sessionId: string): ChatSession | null {
  return sessions.get(sessionId) ?? null;
}

export async function destroySession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.destroy();
}

/** Called by scheduler's Docker event handler when a chat container dies */
export function onChatContainerDie(sessionId: string): void {
  const s = sessions.get(sessionId);
  s?.onContainerDie();
}

// ─── ChatSession class ───

export class ChatSession {
  readonly sessionId: string;
  private state: State = "idle";

  // Container
  private containerId: string | null = null;
  private bridgeUrl: string | null = null;

  // Bridge WS (singleton)
  private bridgeWs: WebSocket | null = null;

  // Frontend clients (fan-out)
  private clients = new Set<WebSocket>();

  // Event buffer for late-joining clients
  private eventBuffer: string[] = [];

  // Assistant message assembly for DB persistence
  private assistantContent = "";
  private toolCalls: unknown[] = [];

  // Callers waiting for READY state
  private readyWaiters: ReadyWaiter[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // ── Public API ──

  async sendPrompt(message: string, images?: unknown[]): Promise<void> {
    // Ensure we're in READY or ACTIVE state
    if (this.state === "idle" || this.state === "recovering") {
      await this.start();
    } else if (this.state === "starting") {
      await this.waitForReady();
    }
    // Now in READY or ACTIVE
    this.state = "active";
    await this.forwardPrompt(message, images);
  }

  async abort(): Promise<void> {
    if (!this.bridgeUrl) return;
    try {
      await fetch(`${this.bridgeUrl}/chat/abort`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* best effort */ }
  }

  subscribeFrontendClient(clientWs: WebSocket): void {
    this.clients.add(clientWs);
    logger.debug({ sessionId: this.sessionId, clientCount: this.clients.size }, "Frontend client subscribed");

    // Replay buffered events only when a turn is in-flight. A settled session
    // (state !== active) must not replay — otherwise switching away and back
    // re-injects the previous reply as a duplicate bubble.
    if (this.state === "active") {
      for (const event of this.eventBuffer) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(event);
        }
      }
    }

    const cleanup = (): void => {
      this.clients.delete(clientWs);
      logger.debug({ sessionId: this.sessionId, clientCount: this.clients.size }, "Frontend client unsubscribed");
    };
    clientWs.on("close", cleanup);
    clientWs.on("error", cleanup);
  }

  async destroy(): Promise<void> {
    // Close bridge WS
    if (this.bridgeWs) {
      this.bridgeWs.close();
      this.bridgeWs = null;
    }
    // Close frontend clients
    for (const c of this.clients) c.close();
    this.clients.clear();
    // Stop container
    await this.stopContainer();
    // Reject any pending waiters
    for (const w of this.readyWaiters) {
      w.reject(new Error("Session destroyed"));
    }
    this.readyWaiters = [];
    this.state = "idle";
    logger.info({ sessionId: this.sessionId }, "ChatSession destroyed");
  }

  /** Docker event: container died */
  onContainerDie(): void {
    logger.info({ sessionId: this.sessionId, prevState: this.state }, "Chat container died");

    if (this.bridgeWs) {
      this.bridgeWs.close();
      this.bridgeWs = null;
    }
    this.containerId = null;
    this.bridgeUrl = null;

    if (this.state === "starting") {
      // Container died during startup — fail all waiters
      for (const w of this.readyWaiters) {
        w.reject(new Error("Container died during startup"));
      }
      this.readyWaiters = [];
      this.state = "idle";
    } else if (this.state === "ready" || this.state === "active") {
      this.state = "recovering";
    }
  }

  // ── Internal ──

  private async start(): Promise<void> {
    this.state = "starting";

    const config = loadConfig();
    // Must match docker-client.ts: name = `va-${taskType}-${taskId}`
    const containerName = `va-chat-${this.sessionId}`;

    try {
      // Remove stale container
      try {
        const docker = getDocker();
        await docker.getContainer(containerName).remove({ force: true });
      } catch { /* doesn't exist */ }

      // Get credentials
      const session = await getSession(this.sessionId);
      if (!session) throw new Error("Chat session not found");
      const sessionUser = await getUserById(session.user_id);
      const queryCtx = {
        tenantId: session.tenant_id,
        userId: session.user_id,
        role: sessionUser?.role === "admin" ? "admin" as const : "member" as const,
      };
      const credId = session.credential_id;
      let cred;
      try {
        cred = credId ? await getCredentialById(queryCtx, credId) : await getDefaultOrFirstAvailableCredential(queryCtx);
      } catch (err) {
        if (err instanceof CredentialKeyUnavailableError) {
          throw new ChatCredentialUnavailableError("凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。");
        }
        if (err instanceof CredentialDecryptError) {
          throw new ChatCredentialUnavailableError("当前会话选择的模型凭证无法解密。请在 Settings 重新保存凭证，或恢复原 master key 后重试。");
        }
        throw err;
      }
      if (!cred) {
        throw new ChatCredentialUnavailableError(
          credId
            ? "当前会话选择的模型凭证不可用。请在右上角选择其他模型，或在 Settings 重新配置后重试。"
            : undefined,
        );
      }

      // Prepare workspace
      const hostWorkDir = join(config.dataDir, "chat-sessions", this.sessionId);
      ensureWorkDir(hostWorkDir);

      // Serialize all credentials for runtime model switching
      const listedCreds = await listCredentials(queryCtx);
      const decryptedCreds = await Promise.all(
        listedCreds
          .filter((c) => c.credential_health !== "decrypt_failed")
          .map((c) => getCredentialById(queryCtx, c.id).catch((err) => {
            if (err instanceof CredentialKeyUnavailableError) return null;
            if (err instanceof CredentialDecryptError) return null;
            throw err;
          })),
      );
      const allCredsJson = JSON.stringify(
        decryptedCreds.filter(Boolean).map(c => ({
          id: c!.id, label: c!.label, proto_type: c!.proto_type,
          base_url: c!.base_url, api_key: c!.api_key, model_id: c!.model_id,
          context_window_tokens: c!.context_window_tokens ?? 128000,
        })),
      );

      const env: Record<string, string> = {
        MODE: "chat",
        SESSION_ID: this.sessionId,
        SESSION_DIR: "/workspace/chat-session",
        ...credentialToWorkerEnv(cred),
        ALL_CREDENTIALS: allCredsJson,
        SERVICE_URL: config.docker.workerServiceUrl,
        CHAT_WORKER_TOKEN: this.sessionId,
        CHAT_USER_ID: queryCtx.userId,
        CHAT_USER_ROLE: queryCtx.role,
        CHAT_TENANT_ID: queryCtx.tenantId,
        IDLE_TIMEOUT_MIN: "10",
      };

      const container = await createWorkerContainer({
        taskId: this.sessionId,
        taskType: "chat",
        image: config.docker.workerImage,
        network: config.docker.network,
        hostWorkDir,
        cpuQuota: 100000,
        memoryBytes: 2 * 1024 * 1024 * 1024,
        autoRemove: true,
        env,
      });

      await container.start();
      this.containerId = container.id;

      logger.info({ sessionId: this.sessionId, containerName }, "Chat worker started");

      // Wait for bridge to initialize
      await new Promise((r) => setTimeout(r, 4000));

      // Get container IP
      const info = await container.inspect();
      // Find container IP from any attached network
      const networks = info.NetworkSettings?.Networks ?? {};
      const ip =
        Object.values(networks).find((n: any) => n?.IPAddress)?.IPAddress ??
        info.NetworkSettings?.IPAddress ??
        containerName;
      this.bridgeUrl = `http://${ip}:8080`;

      // Connect bridge WS
      await this.connectBridgeWs();

      // READY — resolve all waiters
      this.state = "ready";
      for (const w of this.readyWaiters) w.resolve();
      this.readyWaiters = [];

      notify({ type: "chat_worker_state", sessionId: this.sessionId, state: "ready" });
      logger.info({ sessionId: this.sessionId, url: this.bridgeUrl }, "ChatSession READY");
    } catch (err) {
      // Fail all waiters
      for (const w of this.readyWaiters) {
        w.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.readyWaiters = [];
      this.state = "idle";
      throw err;
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  private connectBridgeWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.bridgeUrl) return reject(new Error("No bridge URL"));

      const wsUrl = this.bridgeUrl.replace("http://", "ws://") + "/chat/events";
      const ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Bridge WS connection timeout (10s)"));
      }, 10000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.bridgeWs = ws;
        logger.info({ sessionId: this.sessionId }, "Bridge WS connected");
        resolve();
      });

      ws.on("message", (data: Buffer) => {
        this.handleBridgeEvent(data.toString());
      });

      ws.on("close", () => {
        if (this.bridgeWs === ws) {
          this.bridgeWs = null;
          if (this.state === "ready" || this.state === "active") {
            this.state = "recovering";
            logger.info({ sessionId: this.sessionId }, "Bridge WS closed, state → recovering");
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        logger.debug({ sessionId: this.sessionId, err: err.message }, "Bridge WS error");
        if (this.bridgeWs === ws) {
          this.bridgeWs = null;
        }
      });
    });
  }

  private handleBridgeEvent(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      this.broadcastToClients(line);
      return;
    }

    // Track assistant content for DB persistence
    if (event.type === "message_start" && (event.message as Record<string, unknown>)?.role === "assistant") {
      this.assistantContent = "";
      // NOTE: do NOT reset this.toolCalls here. pi emits multiple
      // message_start -> message_end cycles per tool turn (see web B16 fix);
      // tool_execution_end may land before or between message cycles. We clear
      // toolCalls only after persisting them at message_end, so a tool-bearing
      // message never loses its result to a subsequent message_start reset.
    }

    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const partial = ame?.partial as Record<string, unknown> | undefined;
      if (partial?.role === "assistant" && Array.isArray(partial.content)) {
        for (const block of partial.content as Array<{ type: string; text?: string }>) {
          if (block.type === "text" && typeof block.text === "string") {
            this.assistantContent = block.text;
          }
        }
      }
    }

    if (event.type === "message_end" && (event.message as Record<string, unknown>)?.role === "assistant") {
      const content = (event.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === "text") this.assistantContent = block.text ?? "";
        }
      }
      // Capture and clear tool calls for THIS message so the next message in a
      // multi-message tool turn starts fresh and we never double-persist.
      const toolCallsForMessage = this.toolCalls;
      this.toolCalls = [];
      // Persist if there is text OR tool calls. Tool-bearing assistant messages
      // frequently carry only a tool_use/thinking block and no text — skipping
      // those (the old `if (this.assistantContent)`) dropped emit-reference /
      // present-artifact results entirely, so cards never rendered on refresh.
      if (this.assistantContent || toolCallsForMessage.length > 0) {
        appendMessage({
          sessionId: this.sessionId,
          role: "assistant",
          content: this.assistantContent,
          toolCalls: toolCallsForMessage.length > 0 ? toolCallsForMessage : undefined,
        })
          .then(() => {
            if (this.bridgeUrl) {
              maybeGenerateTitle({ sessionId: this.sessionId, bridgeUrl: this.bridgeUrl })
                .then((title) => {
                  if (title) {
                    const event = JSON.stringify({
                      session_id: this.sessionId,
                      type: "session_title",
                      title,
                    });
                    this.eventBuffer.push(event);
                    if (this.eventBuffer.length > EVENT_BUFFER_SIZE) {
                      this.eventBuffer.shift();
                    }
                    this.broadcastToClients(event);
                    logger.info({ sessionId: this.sessionId, title }, "Broadcasted chat session_title");
                  }
                })
                .catch((err) => logger.debug({ err, sessionId: this.sessionId }, "Chat title generation failed"));
            }
          })
          .catch((err) => logger.warn({ err }, "Failed to persist assistant message"));
      }
    }

    if (event.type === "tool_execution_end") {
      this.toolCalls.push({
        tool: (event.tool ?? event.toolName ?? event.name) as string,
        args: (event.args_summary ?? event.args ?? "") as string,
        result: (event.result ?? event.result_summary ?? "") as string,
      });
    }

    // Clear buffer on conversation completion
    if (event.type === "agent_end") {
      // Safety flush: if tool calls were accumulated but never persisted by a
      // trailing message_end (e.g. tool_execution_end after the final
      // message_end), persist them now so emit-reference / present-artifact
      // results are never stranded.
      if (this.toolCalls.length > 0) {
        const toolCallsForMessage = this.toolCalls;
        this.toolCalls = [];
        appendMessage({
          sessionId: this.sessionId,
          role: "assistant",
          content: "",
          toolCalls: toolCallsForMessage,
        }).catch((err) =>
          logger.warn({ err }, "Failed to persist trailing tool calls at agent_end"),
        );
      }
      this.eventBuffer = [];
      if (this.state === "active") this.state = "ready";
    }

    // Bridge error events: persist as a low-key system notice (task-d9b94859)
    // and notify clients via system_message so the ephemeral copy dedupes.
    if (event.type === "error") {
      const content = typeof event.error === "string" && event.error ? event.error : "ERR_INTERNAL";
      void this.persistSystemNotice(content);
    }

    // Serialize with session_id envelope
    const serialized = JSON.stringify({ session_id: this.sessionId, ...event });
    this.broadcastToClients(serialized);

    // Buffer for late-joining clients during an in-flight turn. Cleared on
    // agent_end (above), so settled sessions hold no replayable content.
    if (event.type !== "agent_end") {
      this.eventBuffer.push(serialized);
      if (this.eventBuffer.length > EVENT_BUFFER_SIZE) {
        this.eventBuffer.shift();
      }
    }
  }

  private broadcastToClients(data: string): void {
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /** Persist a system notice and broadcast it (not buffered — persisted rows
   *  are re-fetched via GET messages; only in-flight turn events replay). */
  private persistSystemNotice(content: string): Promise<void> {
    return appendMessage({ sessionId: this.sessionId, role: "system", content })
      .then((row) => {
        this.broadcastSystemMessage({
          id: row.id,
          seq: row.seq,
          content,
          created_at: row.created_at.toISOString(),
        });
      })
      .catch((err) => logger.warn({ err, sessionId: this.sessionId }, "Failed to persist system notice"));
  }

  /** Broadcast a service-persisted system notice to connected clients. */
  broadcastSystemMessage(msg: { id: string; seq: number; content: string; created_at: string }): void {
    this.broadcastToClients(JSON.stringify({
      session_id: this.sessionId,
      type: "system_message",
      ...msg,
    }));
  }

  private async forwardPrompt(message: string, images?: unknown[]): Promise<void> {
    if (!this.bridgeUrl) throw new Error("Bridge not available");

    const res = await fetch(`${this.bridgeUrl}/chat/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, images }),
      signal: AbortSignal.timeout(10000),
    });
    const result = (await res.json()) as { ok: boolean };
    if (!result.ok) throw new Error("Bridge rejected prompt");
  }

  /** Forward set-model command to bridge → pi */
  async setModel(credentialId: string): Promise<void> {
    // Auto-start if container is not running
    if (this.state === "idle" || this.state === "recovering") {
      await this.start();
    } else if (this.state === "starting") {
      await this.waitForReady();
    }
    if (!this.bridgeUrl) throw new Error("Bridge not available");

    const res = await fetch(`${this.bridgeUrl}/chat/set-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialId }),
      signal: AbortSignal.timeout(10000),
    });
    const result = (await res.json()) as { ok: boolean; error?: string };
    if (!result.ok) throw new Error(result.error ?? "Bridge rejected set-model");
  }

  private async stopContainer(): Promise<void> {
    if (!this.containerId) return;
    try {
      const docker = getDocker();
      const container = docker.getContainer(this.containerId);
      await container.stop({ t: 10 });
      await container.remove({ force: true });
    } catch (err) {
      logger.warn({ err, sessionId: this.sessionId }, "Failed to stop chat container");
    }
    this.containerId = null;
    this.bridgeUrl = null;
  }
}
