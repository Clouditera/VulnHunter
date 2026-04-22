/**
 * Chat Worker Manager — manages session → container mapping.
 * Spawns chat worker containers on demand, monitors lifecycle.
 */

import { join } from "node:path";
import {
  createWorkerContainer,
  ensureWorkDir,
  getDocker,
} from "../workers/docker-client.js";
import { getDefaultCredential } from "../settings/storage.js";
import { logger } from "../../infra/logger.js";
import type { ServiceConfig } from "../../infra/config.js";

interface WorkerState {
  containerId: string | null;
  containerName: string;
  state: "idle" | "starting" | "running";
}

const workers = new Map<string, WorkerState>();

export function getWorkerUrl(sessionId: string, _config: ServiceConfig): string | null {
  const w = workers.get(sessionId);
  if (!w || w.state !== "running" || !w.containerId) return null;
  return `http://${w.containerName}:8080`; // containerName stores IP after ensureWorker
}

export async function ensureWorker(
  sessionId: string,
  config: ServiceConfig,
): Promise<string> {
  const existing = workers.get(sessionId);
  if (existing?.state === "running" && existing.containerId) {
    // Verify container is still running
    try {
      const docker = getDocker();
      const container = docker.getContainer(existing.containerId);
      const info = await container.inspect();
      if (info.State.Running) {
        return `http://${existing.containerName}:8080`;
      }
    } catch {
      // Container gone, respawn
    }
  }

  const containerName = `vh-chat-${sessionId.slice(0, 12)}`;
  workers.set(sessionId, { containerId: null, containerName, state: "starting" });

  // Get LLM credentials
  const cred = await getDefaultCredential();
  if (!cred) throw new Error("No LLM credentials configured");

  // Prepare workspace
  const hostWorkDir = join(config.dataDir, "chat-sessions", sessionId);
  ensureWorkDir(hostWorkDir);

  const env: Record<string, string> = {
    MODE: "chat",
    SESSION_ID: sessionId,
    SESSION_DIR: "/workspace/chat-session",
    MODEL_PROTO_TYPE: cred.proto_type,
    LLM_MODEL_NAME: cred.model_id,
    LLM_API_KEY: cred.api_key,
    LLM_BASE_URL: cred.base_url ?? "",
    SERVICE_URL: `http://vulnhunt-service:${config.port}`,
    CHAT_WORKER_TOKEN: sessionId, // Simple token for MCP auth
    IDLE_TIMEOUT_MIN: "10",
  };

  // Remove old container with same name if exists
  try {
    const docker = getDocker();
    const old = docker.getContainer(containerName);
    await old.remove({ force: true });
  } catch { /* ok, doesn't exist */ }

  const container = await createWorkerContainer({
    taskId: sessionId,
    taskType: "chat",
    image: config.docker.workerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 100000, // 1 CPU
    memoryBytes: 2 * 1024 * 1024 * 1024, // 2GB
    env,
  });

  await container.start();

  const w = workers.get(sessionId)!;
  w.containerId = container.id;
  w.state = "running";

  logger.info({ sessionId, containerName }, "Chat worker started");

  // Wait for bridge to initialize
  await new Promise((r) => setTimeout(r, 4000));

  // Get container IP (service runs on host, can't resolve container names)
  const info = await container.inspect();
  const ip = info.NetworkSettings?.Networks?.bridge?.IPAddress
    ?? info.NetworkSettings?.IPAddress
    ?? containerName;
  const url = `http://${ip}:8080`;
  w.containerName = ip; // Store IP for future lookups
  logger.info({ sessionId, url }, "Chat worker bridge URL");
  return url;
}

export async function stopWorker(sessionId: string): Promise<void> {
  const w = workers.get(sessionId);
  if (!w?.containerId) return;

  try {
    const docker = getDocker();
    const container = docker.getContainer(w.containerId);
    await container.stop({ t: 10 });
    await container.remove({ force: true });
  } catch (err) {
    logger.warn({ err, sessionId }, "Failed to stop chat worker");
  }

  workers.delete(sessionId);
  logger.info({ sessionId }, "Chat worker stopped");
}

export function markWorkerStopped(sessionId: string): void {
  workers.delete(sessionId);
}
