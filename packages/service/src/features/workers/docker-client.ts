import Dockerode from "dockerode";
import { logger } from "../../infra/logger.js";

let _docker: Dockerode | null = null;

export function getDocker(): Dockerode {
  if (!_docker) {
    throw new Error("Docker client not initialized — call initDocker() first");
  }
  return _docker;
}

export function initDocker(socketPath = "/var/run/docker.sock"): Dockerode {
  _docker = new Dockerode({ socketPath });
  logger.info({ socketPath }, "Docker client initialized");
  return _docker;
}

export const LABEL_MANAGED = "vulnhunt.managed";
export const LABEL_TASK_ID = "vulnhunt.task_id";
export const LABEL_TASK_TYPE = "vulnhunt.task_type";

export interface WorkerContainerSpec {
  taskId: string;
  taskType: "scan" | "chat" | "report";
  image: string;
  env: Record<string, string>;
  cpuQuota?: number;  // default 200000 = 2 CPU
  memoryBytes?: number; // default 4GB
  volumeName?: string;
  hostWorkDir?: string; // bind mount host path → /workspace
  network?: string;
}

export async function createWorkerContainer(spec: WorkerContainerSpec): Promise<Dockerode.Container> {
  const docker = getDocker();
  const name = `vh-${spec.taskType}-${spec.taskId}`;

  const env = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);

  const mounts: Dockerode.HostConfig["Mounts"] = [];
  if (spec.hostWorkDir) {
    mounts.push({
      Type: "bind" as const,
      Source: spec.hostWorkDir,
      Target: "/workspace",
    });
  } else if (spec.volumeName) {
    mounts.push({
      Type: "volume" as const,
      Source: spec.volumeName,
      Target: "/workspace",
    });
  }

  const container = await docker.createContainer({
    name,
    Image: spec.image,
    Env: env,
    Labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_TASK_ID]: spec.taskId,
      [LABEL_TASK_TYPE]: spec.taskType,
      "vulnhunt.created_at": new Date().toISOString(),
    },
    HostConfig: {
      CpuQuota: spec.cpuQuota ?? 200000,
      Memory: spec.memoryBytes ?? 4 * 1024 * 1024 * 1024,
      MemorySwap: spec.memoryBytes ?? 4 * 1024 * 1024 * 1024,
      NetworkMode: spec.network ?? "vulnhunt-internal",
      Mounts: mounts,
    },
  });

  logger.info({ name, taskId: spec.taskId, taskType: spec.taskType }, "Worker container created");
  return container;
}

import { mkdirSync, rmSync } from "node:fs";

export function ensureWorkDir(hostPath: string): void {
  mkdirSync(hostPath, { recursive: true });
  logger.debug({ hostPath }, "Work directory ensured");
}

export function removeWorkDir(hostPath: string): void {
  try {
    rmSync(hostPath, { recursive: true, force: true });
    logger.info({ hostPath }, "Work directory removed");
  } catch (err) {
    logger.warn({ hostPath, err }, "Could not remove work directory");
  }
}

/** @deprecated Use ensureWorkDir with bind mount instead */
export async function ensureVolume(volumeName: string): Promise<void> {
  const docker = getDocker();
  try {
    await docker.getVolume(volumeName).inspect();
  } catch {
    await docker.createVolume({ Name: volumeName, Labels: { [LABEL_MANAGED]: "true" } });
    logger.info({ volumeName }, "Docker volume created");
  }
}

export async function removeVolume(volumeName: string): Promise<void> {
  const docker = getDocker();
  try {
    await docker.getVolume(volumeName).remove();
    logger.info({ volumeName }, "Docker volume removed");
  } catch (err) {
    logger.warn({ volumeName, err }, "Could not remove volume");
  }
}

export async function listManagedContainers(): Promise<Dockerode.ContainerInfo[]> {
  const docker = getDocker();
  return docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_MANAGED}=true`] }),
  });
}

export function subscribeToDockerEvents(
  onEvent: (event: { action: string; taskId: string; taskType: string; exitCode?: number }) => void,
): () => void {
  const docker = getDocker();
  let stream: NodeJS.ReadableStream | null = null;
  let active = true;

  docker.getEvents(
    {
      filters: JSON.stringify({
        label: [`${LABEL_MANAGED}=true`],
        type: ["container"],
        event: ["start", "die", "oom"],
      }),
    },
    (err, s) => {
      if (err || !s) {
        logger.error({ err }, "Failed to subscribe to docker events");
        return;
      }
      stream = s;

      s.on("data", (chunk: Buffer) => {
        try {
          const ev = JSON.parse(chunk.toString());
          const taskId = ev.Actor?.Attributes?.[LABEL_TASK_ID];
          const taskType = ev.Actor?.Attributes?.[LABEL_TASK_TYPE];
          if (!taskId) return;

          const exitCode = ev.Actor?.Attributes?.exitCode
            ? Number(ev.Actor.Attributes.exitCode)
            : undefined;

          onEvent({ action: ev.Action, taskId, taskType, exitCode });
        } catch {}
      });

      s.on("end", () => {
        if (active) {
          // Reconnect after a short delay
          setTimeout(() => subscribeToDockerEvents(onEvent), 3000);
        }
      });
    },
  );

  return () => {
    active = false;
    if (stream) { (stream as import('stream').Readable).destroy?.(); }
  };
}
