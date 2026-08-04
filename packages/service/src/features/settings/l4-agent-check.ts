/**
 * L4 deep verification: pi CLI headless agent circuit check.
 *
 * Runs `pi -p --mode json` as a subprocess with the user's credential to verify
 * a real agent loop closes: model → tool call → tool result → assistant completes.
 *
 * Design: subprocess isolation (agent crash doesn't affect service), same pi
 * binary as worker, JSON event stream for programmatic assertion.
 *
 * models.json is placed at `<workDir>/agent/models.json` and pi is pointed
 * there via `PI_CODING_AGENT_DIR` env (pi CLI reads models.json by convention,
 * not via a CLI flag).
 *
 * Spec: architecture/llm-layer-unify-pi-version-native-credential-test-v1.0.md §3 L4
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_VERSION } from "@vulnhunter/shared";
import { logger } from "../../infra/logger.js";

export interface L4CheckInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protoType: string;
  thinkingEffort?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export type L4CheckResult = {
  status: "pass" | "fail";
  durationMs: number;
  detail: string;
  /** Raw JSON events from pi CLI (truncated for diagnostics). */
  events?: unknown[];
};

const L4_TIMEOUT_MS = 60_000;

/**
 * Build a minimal models.json for pi CLI convention path
 * (`<agentDir>/models.json`). Declares a "platform" provider with the user's
 * real baseUrl + API key (via env template). pi reads this on startup.
 */
async function writeModelsJson(
  agentDir: string,
  input: L4CheckInput,
): Promise<void> {
  const apiType =
    input.protoType === "anthropic" || input.protoType === "anthropic-messages"
      ? "anthropic-messages"
      : input.protoType === "openai-responses"
        ? "openai-responses"
        : "openai-completions";

  // Match prepare-worker's proven format. apiKey omitted — pi CLI gets it
  // via --api-key flag (models.json ${ENV} templates are NOT supported by pi).
  const models = {
    providers: {
      platform: {
        api: apiType,
        baseUrl: input.baseUrl.replace(/\/$/, ""),
        models: [{ id: input.modelId }],
      },
    },
  };

  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify(models, null, 2) + "\n", "utf-8");
}

/**
 * Run L4 check: spawn pi CLI headless, parse JSON events, assert agent settled
 * with non-error assistant output.
 */
export async function runL4Check(input: L4CheckInput): Promise<L4CheckResult> {
  const start = Date.now();
  let workDir: string | null = null;

  try {
    workDir = await mkdtemp(join(tmpdir(), "pi-l4-"));
    const agentDir = join(workDir, "agent");
    await writeModelsJson(agentDir, input);

    const args = [
      "-p",
      "--mode", "json",
      "--no-session",
      "--provider", "platform",
      "--model", input.modelId,
      "--api-key", input.apiKey,
      "Reply with the single word: ok",
    ];

    const events: unknown[] = [];
    let stderr = "";

    await new Promise<void>((resolve) => {
      const child = spawn("pi", args, {
        cwd: workDir!,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, L4_TIMEOUT_MS);

      input.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        child.kill("SIGTERM");
      });

      let settled = false;

      let stdoutBuf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("Warning:")) continue;
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            // Non-JSON line — skip
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("close", () => {
        if (!settled) {
          clearTimeout(timer);
          // Parse any remaining stdout
          if (stdoutBuf.trim()) {
            try { events.push(JSON.parse(stdoutBuf.trim())); } catch { /* skip */ }
          }
          settled = true;
          resolve();
        }
      });

      // Early exit on any non-zero or null exit code (ENOENT, bad args, etc.)
      child.on("exit", (code) => {
        if (!settled && code !== 0) {
          clearTimeout(timer);
          if (stdoutBuf.trim()) {
            try { events.push(JSON.parse(stdoutBuf.trim())); } catch { /* skip */ }
          }
          settled = true;
          resolve();
        }
      });

      child.on("error", () => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          resolve();
        }
      });
    });

    const durationMs = Date.now() - start;

    // Assert: agent settled + assistant message with non-error stopReason
    const agentSettled = events.some(
      (e) => (e as { type?: string }).type === "agent_settled",
    );

    const assistantMessages = events.filter(
      (e) =>
        (e as { type?: string }).type === "message_end" &&
        (e as { message?: { role?: string } }).message?.role === "assistant",
    );

    const hasError = assistantMessages.some(
      (e) => (e as { message?: { stopReason?: string } }).message?.stopReason === "error",
    );

    const hasContent = assistantMessages.some((e) => {
      const content = (e as { message?: { content?: unknown[] } }).message?.content;
      return Array.isArray(content) && content.length > 0;
    });

    if (!agentSettled && events.length === 0) {
      return {
        status: "fail",
        durationMs,
        detail: stderr.trim().slice(0, 300) || "pi CLI produced no output",
      };
    }

    if (!agentSettled) {
      return {
        status: "fail",
        durationMs,
        detail: "pi CLI did not reach agent_settled state",
        events: events.slice(0, 5),
      };
    }

    if (hasError) {
      const errMsg = assistantMessages.find(
        (e) => (e as { message?: { errorMessage?: string } }).message?.errorMessage,
      );
      const detail =
        (errMsg as { message?: { errorMessage?: string } })?.message?.errorMessage ??
        "upstream error";
      return {
        status: "fail",
        durationMs,
        detail: detail.slice(0, 300),
        events: events.slice(0, 5),
      };
    }

    if (!hasContent) {
      return {
        status: "fail",
        durationMs,
        detail: "Agent completed but produced no output content",
        events: events.slice(0, 5),
      };
    }

    return {
      status: "pass",
      durationMs,
      detail: `Agent circuit OK (pi ${PI_VERSION}, ${assistantMessages.length} assistant message(s))`,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, durationMs }, "L4 check failed");
    return {
      status: "fail",
      durationMs,
      detail: msg.slice(0, 300),
    };
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
