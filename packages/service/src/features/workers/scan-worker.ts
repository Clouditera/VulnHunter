import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ServiceConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { mergeTaskMetadata } from "../tasks/storage.js";
import { computeScanDeadlineAt } from "../tasks/scan-duration.js";
import {
  createWorkerContainer,
  ensureWorkDir,
  removeWorkDir,
  getDocker,
  LABEL_TASK_ID,
  LABEL_TASK_TYPE,
  LABEL_SCHEDULER_CLAIM,
} from "./docker-client.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { renderSandboxMd } from "./sandbox-inject.js";

import type { DbTask } from "../tasks/storage.js";
import { createAuditCompletionEngineRun, fingerprintAuditCompletion } from "./audit-completion.js";
import { getDynamicProvider, type DynamicSandboxMapping } from "../dynamic/provider.js";
import {
  injectSandboxFiles,
  renderInjectionFiles,
  SANDBOX_RUNTIME_DIR,
} from "./sandbox-inject.js";

export const STATIC_ONLY_SCHED_INSTR = "平台策略：本次仅执行静态审计；不得选择 poc-verify 或 exp-build；完成静态审计后进入报告阶段。";

function optionalTextMeta(meta: DbTask["source_meta"] | null | undefined, key: string): string {
  const value = meta?.[key];
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (normalized.includes("\0")) throw new Error(`Invalid NUL in task metadata: ${key}`);
  return normalized;
}

export function scanInputEnvFromMeta(meta: DbTask["source_meta"] | null | undefined, opts?: { dynamicEnabled?: boolean }): Record<string, string> {
  const canonicalUserInstr = optionalTextMeta(meta, "user_instr");
  const env: Record<string, string> = {
    VULNFORGE_AUDIT_SCOPE: optionalTextMeta(meta, "audit_scope"),
    VULNFORGE_VULN_FOCUS: optionalTextMeta(meta, "vuln_focus"),
    VULNFORGE_USER_INSTR: canonicalUserInstr || optionalTextMeta(meta, "audit_focus"),
    // fish 2026-08-09: output language (BCP-47). Empty → engine default zh-CN.
    VULNFORGE_OUTPUT_LANGUAGE: optionalTextMeta(meta, "output_language"),
  };
  if (opts?.dynamicEnabled) {
    // H5 §5/H1: dynamic runs must not carry the static-only scheduling
    // instruction — pass the task's own sched_instr (or none → flow default).
    env.VULNFORGE_DYNAMIC_ENABLED = "true";
    env.VULNFORGE_SCHED_INSTR = optionalTextMeta(meta, "sched_instr");
    env.VULNFORGE_ENABLE_POC = "true";
    env.VULNFORGE_ENABLE_EXP = "true";
    env.VULNFORGE_ENABLE_CHAIN = booleanMeta(meta, "enable_chain") ? "true" : "false";
  } else {
    env.VULNFORGE_SCHED_INSTR = STATIC_ONLY_SCHED_INSTR;
  }
  return env;
}

function booleanMeta(meta: DbTask["source_meta"] | null | undefined, key: string): boolean {
  const v = meta?.[key];
  return v === true || v === "true";
}

export function getHostWorkDir(dataDir: string, taskId: string): string {
  return join(dataDir, "workspaces", taskId);
}

export async function spawnScanWorker(
  task: DbTask,
  config: ServiceConfig,
  llmEnv: Record<string, string>,
  claimToken: string,
  resume = false,
  continueMode = false,
): Promise<string> {
  const hostWorkDir = getHostWorkDir(config.dataDir, task.id);

  if (!resume && !continueMode) {
    ensureWorkDir(hostWorkDir);
  }

  // Deterministic name is the final atomic guard. Never replace an existing
  // container here: reconciliation alone decides whether an exited container
  // is eligible for owner-bound cleanup.
  try {
    const old = getDocker().getContainer(`vh-scan-${task.id}`);
    const info = await old.inspect();
    const existingToken = info.Config?.Labels?.[LABEL_SCHEDULER_CLAIM];
    throw new Error(`Scan worker name conflict for task ${task.id} (state=${info.State?.Status ?? "unknown"}, claim=${existingToken ?? "legacy"})`);
  } catch (err: any) {
    if (err?.statusCode !== 404) throw err;
  }

  if (!resume) {
    const engineRun = createAuditCompletionEngineRun(
      randomUUID(),
      new Date().toISOString(),
      continueMode ? fingerprintAuditCompletion(join(hostWorkDir, "out")) : null,
    );
    // H3: platform-accounted scan deadline (observability + scheduler fallback
    // clock). A fresh logical run (fresh or continue) restarts the budget from
    // now; a resume keeps the prior deadline (pause-shift semantics, v1 has no
    // mid-run pause so this is naturally unchanged). The worker's own deadline
    // runner remains the normal executor.
    const scanTimeoutSeconds = Number(stringMeta(task.source_meta, "scan_timeout")) || 0;
    await mergeTaskMetadata(task.id, {
      engine_run: engineRun,
      // A new logical run must not inherit the previous run's warning. Current
      // stage/completion warnings are merged again during terminal handling.
      execution: { warning: null },
      ...(scanTimeoutSeconds > 0 ? { deadline_at: computeScanDeadlineAt(scanTimeoutSeconds) } : {}),
    });
  }

  const dynamicEnabled = booleanMeta(task.source_meta, "dynamic_enabled");
  let sandbox: { mapping: DynamicSandboxMapping; privateKey: string } | null = null;
  if (dynamicEnabled) {
    const mapping = await getDynamicProvider().getTaskSandbox(task.id);
    const privateKey = mapping?.state === "ready" ? await getDynamicProvider().peekTaskSshPrivateKey(task.id) : null;
    if (mapping?.state === "ready" && privateKey) {
      sandbox = { mapping, privateKey };
    } else if (resume || continueMode) {
      // H2 invariant (resume/continue): allocation ran in a prior lifecycle —
      // a missing ready sandbox here is a broken pipeline; fail loud.
      throw new Error(`Dynamic task ${task.id} requires a ready sandbox + in-memory ssh key before worker start (mapping=${mapping?.state ?? "none"}, key=${privateKey ? "present" : "missing"})`);
    }
    // Fresh dynamic tasks spawn WITHOUT a sandbox: the onboard gate runs
    // inside this worker; its apply_sandbox tool POSTs
    // /internal/sandbox-plane/apply, which allocates + injects the SSH files
    // into the RUNNING container. The tmpfs is mounted up-front (files arrive
    // later; ssh tolerates the absent config include until then).
  }
  if (sandbox && (resume || continueMode)) {
    // Continue/resume pre-write the workspace sandbox description for legacy
    // tasks whose out/.sandbox_config is missing (engine-native gate: fresh
    // runs get it from apply_sandbox). Alias-only content, no coordinates.
    const cfgPath = join(hostWorkDir, "out", ".sandbox_config");
    if (!existsSync(cfgPath)) {
      const capabilities = ((task.metadata as Record<string, unknown> | undefined)?.prepare as
        | { sandbox_capabilities?: string[] }
        | undefined)?.sandbox_capabilities ?? [];
      await mkdir(join(hostWorkDir, "out"), { recursive: true });
      await writeFile(cfgPath, renderSandboxMd(capabilities), { mode: 0o644 });
      logger.info({ taskId: task.id }, "Pre-wrote out/.sandbox_config for continue/resume");
    }
  }

  const container = await createWorkerContainer({
    taskId: task.id,
    taskType: "scan",
    image: config.docker.workerImage,
    network: config.docker.network,
    hostWorkDir,
    cpuQuota: 200000,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    labels: { [LABEL_SCHEDULER_CLAIM]: claimToken },
    // Dynamic tasks always get the tmpfs — fresh tasks receive the SSH files
    // via the gate callback's injection AFTER start; resume/continue get them
    // here before start.
    ...(dynamicEnabled ? { tmpfs: { [SANDBOX_RUNTIME_DIR]: "rw,nosuid,nodev,size=4m" } } : {}),
    env: {
      ...llmEnv,
      MODE: "scan",
      TASK_ID: task.id,
      // RESUME env removed 2026-08-20: --resume is retired platform-wide
      // (checkpoint replay spins on cyclic flows). All respawned workers run
      // --continue; scan-mode.sh no longer reads RESUME.
      CONTINUE: continueMode ? "1" : "0",
      ...scanInputEnvFromMeta(task.source_meta, { dynamicEnabled }),
      // engine-native gate: the sandbox description is a workspace file
      // (written by apply_sandbox during onboard, or pre-rendered on
      // continue/resume) — path fixed, key unchanged.
      ...(dynamicEnabled ? { VULNFORGE_SANDBOX_CFG: "/workspace/out/.sandbox_config" } : {}),
      SCAN_TIMEOUT: stringMeta(task.source_meta, "scan_timeout"),
      TIMEOUT_MODE: stringMeta(task.source_meta, "timeout_mode"),
      MAX_ITEMS_PER_RECON: stringMeta(task.source_meta, "max_items_per_recon"),
      RECURSION_LIMIT: stringMeta(task.source_meta, "recursion_limit"),
      MINIO_ENDPOINT: `http://${config.minio.endpoint}:${config.minio.port}`,
      MINIO_ACCESS_KEY: config.minio.accessKey,
      MINIO_SECRET_KEY: config.minio.secretKey,
      MINIO_BUCKET: config.minio.bucket,
      SERVICE_URL: config.docker.workerServiceUrl,
    },
  });

  if (sandbox) {
    // Resume/continue (allocation already done): inject AFTER start — the
    // tmpfs only exists once the container is running (putArchive before
    // start lands in the image layer and gets mounted over). The agent only
    // touches these files when it begins dynamic work, long after the
    // ms-scale injection.
    const files = renderInjectionFiles(sandbox.mapping, sandbox.privateKey, {
      sshHostOverride: config.sandboxSshHostOverride ?? null,
      bastionSpec: config.sandboxSshBastion ?? null,
      bastionHostKey: config.sandboxSshBastionHostKey ?? null,
      bastionIdentityOpenSsh: config.sandboxSshBastionIdentity ?? null,
    });
    await container.start();
    await injectSandboxFiles(container, files);
    logger.info({ taskId: task.id, sandboxId: sandbox.mapping.sandbox_id }, "Sandbox SSH files injected into worker tmpfs");
  } else {
    // Fresh dynamic: the gate callback injects later. Static: nothing to
    // inject.
    await container.start();
  }
  // NOTE: spawnScanWorker no longer updates task state. The Scheduler performs
  // the token-CAS transition preparing → running (markSchedulerClaimRunning).
  logger.info({ taskId: task.id, claimToken, hostWorkDir, resume, continueMode }, "Scan worker started");
  return container.id;
}

function stringMeta(meta: DbTask["source_meta"] | null | undefined, key: string): string {
  const value = meta?.[key];
  if (value === undefined || value === null) return "";
  return String(value);
}

export async function hasRunningScanWorkerByClaim(taskId: string, token: string): Promise<boolean> {
  const containers = await getDocker().listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`, `${LABEL_SCHEDULER_CLAIM}=${token}`] }),
  });
  return containers.some((info) => info.State === "running" || info.State === "paused");
}

export async function stopScanWorkerByClaim(taskId: string, token: string): Promise<void> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`, `${LABEL_SCHEDULER_CLAIM}=${token}`] }),
  });
  for (const info of containers) {
    try {
      const container = docker.getContainer(info.Id);
      if (info.State === "running" || info.State === "paused") await container.stop({ t: 30 }).catch(() => undefined);
      await container.remove({ force: true });
      logger.info({ taskId, token, containerId: info.Id }, "Claim-owned scan worker stopped and removed");
    } catch (err) {
      logger.warn({ err, taskId, token, containerId: info.Id }, "Failed to stop claim-owned scan worker");
    }
  }
}

export async function stopScanWorker(taskId: string): Promise<void> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`] }),
  });

  for (const info of containers) {
    try {
      const container = docker.getContainer(info.Id);
      await container.stop({ t: 30 });
      await container.remove({ force: true });
      logger.info({ taskId, containerId: info.Id }, "Scan worker stopped and removed");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to stop worker container");
    }
  }
}

/**
 * Freeze the running scan container in place (SIGSTOP via the Docker freezer
 * cgroup). Unlike stop+resume, this preserves full process/memory state, which
 * is required for VulnForge's cyclic flow — YoungFlow's checkpoint `--resume`
 * cannot correctly restore loop stages (see YoungFlow issue #27). Returns the
 * number of containers paused.
 */
export async function pauseScanWorker(taskId: string): Promise<number> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: false,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`] }),
  });
  let paused = 0;
  for (const info of containers) {
    try {
      await docker.getContainer(info.Id).pause();
      paused++;
      logger.info({ taskId, containerId: info.Id }, "Scan worker paused (docker pause)");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to pause worker container");
    }
  }
  return paused;
}

/**
 * Resume a previously frozen scan container (docker unpause). Includes paused
 * containers in the listing since a paused container is still "running" but we
 * keep `all: true` for safety. Returns the number of containers unpaused.
 */
export async function unpauseScanWorker(taskId: string): Promise<number> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=scan`] }),
  });
  let unpaused = 0;
  for (const info of containers) {
    // Only attempt unpause on containers actually in the paused state.
    if (info.State !== "paused" && !/\(Paused\)/i.test(info.Status ?? "")) continue;
    try {
      await docker.getContainer(info.Id).unpause();
      unpaused++;
      logger.info({ taskId, containerId: info.Id }, "Scan worker unpaused (docker unpause)");
    } catch (err) {
      logger.warn({ err, taskId }, "Failed to unpause worker container");
    }
  }
  return unpaused;
}

export function cleanupScanWorkDir(dataDir: string, taskId: string, cleanupImage?: string): void {
  removeWorkDir(getHostWorkDir(dataDir, taskId), cleanupImage);
}
