/**
 * H2 sandbox instance lifecycle (docker-style: fish 2026-07-17):
 *   task starts (dynamic on) → create; running → ready;
 *   task pauses/ends → STOP only (never destroy); task deleted → release.
 * No lease anywhere — the consumer drives everything; the reconciler only
 * closes crash windows.
 */

import { logger } from "../../infra/logger.js";
import { generateTaskSshKeypair, type TaskSshKeypair } from "./ssh-keys.js";
import type { DbTask } from "../tasks/storage.js";
import { getUserById } from "../auth/storage.js";
import {
  createSandboxPlaneSandbox,
  getSandboxPlaneSandbox,
  getSandboxPlaneProfile,
  releaseSandboxPlaneSandbox,
  resumeSandboxPlaneSandbox,
  stopSandboxPlaneSandbox,
  SandboxPlaneCapacityError,
  SandboxPlaneUnavailableError,
  type SandboxPlaneSandbox,
} from "../sandbox-plane/client.js";
import {
  blockPendingDynamicStates,
  deleteTaskSandbox,
  getTaskSandbox,
  listActiveTaskSandboxes,
  listReadySandboxesOfTerminalTasks,
  listTaskSandboxesWithMissingTask,
  sandboxRequestId,
  sumRunningSandboxesForUser,
  updateTaskSandboxState,
  upsertTaskSandbox,
  type TaskSandbox,
} from "./storage.js";

/** Rejected by the per-user quota gate (H2 §3b) — counts embedded for the O1-visible message. */
export class SandboxQuotaError extends Error {
  constructor(
    message: string,
    readonly detail: { running: number; max_running: number; cpu: number; max_cpu: number; memory_gb: number; max_memory_gb: number },
  ) {
    super(message);
    this.name = "SandboxQuotaError";
  }
}

export { SandboxPlaneCapacityError };

const PLANE_TERMINAL_STATUSES = new Set(["released", "failed", "expired"]);
const CREATE_POLL_INTERVAL_MS = 2_000;
const CREATE_POLL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Per-task ed25519 keypair (H1 §2: never in DB/env/workspace/logs).
// The private key lives only in this process's memory until injection into
// the worker tmpfs at worker start. A service restart between create and
// worker start loses it — ensureSandboxForTask then recycles the instance
// (release + fresh create with a new key) instead of wedging on an
// unreachable sandbox.
// ---------------------------------------------------------------------------
const sshKeys = new Map<string, TaskSshKeypair>();

export function ensureTaskSshKeypair(taskId: string): { publicKeyOpenSsh: string } {
  let entry = sshKeys.get(taskId);
  if (!entry) {
    entry = generateTaskSshKeypair();
    sshKeys.set(taskId, entry);
  }
  return { publicKeyOpenSsh: entry.publicKeyOpenSsh };
}

/** True when the in-memory keypair for this task still exists (false after restart). */
export function hasTaskSshKeypair(taskId: string): boolean {
  return sshKeys.has(taskId);
}

/** H1 handoff: the OpenSSH private key file content for worker tmpfs injection. */
export function peekTaskSshPrivateKey(taskId: string): string | null {
  return sshKeys.get(taskId)?.privateKeyOpenSsh ?? null;
}

export function dropTaskSshKeypair(taskId: string): void {
  sshKeys.delete(taskId);
}

// ---------------------------------------------------------------------------
// Quota gate (H2 §3b): per-user running count + cpu/memory sums; 0 = unlimited.
// ---------------------------------------------------------------------------
export interface QuotaDecision {
  allowed: boolean;
  usage: { running: number; cpu: number; memory_mb: number };
  limits: { max_running: number; max_cpu: number; max_memory_gb: number };
}

export function evaluateQuota(
  usage: { running: number; cpu: number; memory_mb: number },
  limits: { max_running: number; max_cpu: number; max_memory_gb: number },
  request: { cpu: number; memory_mb: number },
): QuotaDecision {
  const { max_running, max_cpu, max_memory_gb } = limits;
  const exceeded =
    (max_running > 0 && usage.running + 1 > max_running) ||
    (max_cpu > 0 && usage.cpu + request.cpu > max_cpu) ||
    (max_memory_gb > 0 && usage.memory_mb + request.memory_mb > max_memory_gb * 1024);
  return { allowed: !exceeded, usage, limits };
}

async function assertQuotaForTask(task: DbTask, request: { cpu: number; memory_mb: number }): Promise<void> {
  const user = await getUserById(task.created_by);
  if (!user) return; // legacy/deleted owner: no quota configured, allow.
  const limits = {
    max_running: user.sandbox_max_running,
    max_cpu: user.sandbox_max_cpu_cores,
    max_memory_gb: user.sandbox_max_memory_gb,
  };
  if (limits.max_running <= 0 && limits.max_cpu <= 0 && limits.max_memory_gb <= 0) return;
  const usage = await sumRunningSandboxesForUser(task.created_by);
  const decision = evaluateQuota(usage, limits, request);
  if (!decision.allowed) {
    throw new SandboxQuotaError(
      `沙箱额度已满：运行中 ${usage.running}/${limits.max_running || "∞"} 台、` +
      `CPU ${usage.cpu}/${limits.max_cpu || "∞"} 核、内存 ${Math.round(usage.memory_mb / 1024)}/${limits.max_memory_gb || "∞"} GB。` +
      `可等待任务结束或联系管理员提升额度。`,
      { running: usage.running, max_running: limits.max_running, cpu: usage.cpu, max_cpu: limits.max_cpu, memory_gb: Math.round(usage.memory_mb / 1024), max_memory_gb: limits.max_memory_gb },
    );
  }
}

// ---------------------------------------------------------------------------
// Allocation (H2 §3): quota gate → idempotent create → poll running → mapping.
// Throws SandboxQuotaError / SandboxPlaneCapacityError (retryable) or Error
// (terminal alloc failure).
// ---------------------------------------------------------------------------
async function pollUntilRunning(sandboxId: string, timeoutMs: number): Promise<SandboxPlaneSandbox> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sandbox = await getSandboxPlaneSandbox(sandboxId);
    if (!sandbox) throw new Error(`Sandbox instance ${sandboxId} disappeared during provisioning`);
    if (sandbox.status === "running") return sandbox;
    if (PLANE_TERMINAL_STATUSES.has(sandbox.status)) {
      throw new Error(`Sandbox instance terminated during provisioning (${sandbox.status}): ${sandbox.failure_reason ?? "no reason"}`);
    }
    if (Date.now() > deadline) throw new Error(`Sandbox instance did not reach running within ${Math.round(timeoutMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, CREATE_POLL_INTERVAL_MS));
  }
}

export interface EnsureSandboxResult {
  mapping: TaskSandbox;
  reused: boolean;
}

/**
 * SandboxPlane replays (consumer, request_id) to the SAME record forever —
 * including terminal ones. After a released instance (delete flow crashed
 * before the task row went away, or QA reruns the same fixture) the replay
 * would wedge re-allocation on a dead record. Advance a deterministic suffix
 * (-r2..-r8) past terminal replays; within an epoch the request_id stays an
 * exact idempotency anchor, and ② single-owner serializes concurrent picks.
 */
const MAX_REQUEST_EPOCH = 8;

async function createSkippingTerminalReplays(
  baseRequestId: string,
  build: (requestId: string) => Parameters<typeof createSandboxPlaneSandbox>[0],
): Promise<{ sandbox: SandboxPlaneSandbox; requestId: string }> {
  for (let epoch = 1; epoch <= MAX_REQUEST_EPOCH; epoch++) {
    const requestId = epoch === 1 ? baseRequestId : `${baseRequestId}-r${epoch}`;
    const sandbox = await createSandboxPlaneSandbox(build(requestId));
    if (!PLANE_TERMINAL_STATUSES.has(sandbox.status)) return { sandbox, requestId };
    logger.warn({ requestId, status: sandbox.status }, "Idempotent replay returned a terminal record; advancing request epoch");
  }
  throw new Error(`Sandbox allocation wedged: ${MAX_REQUEST_EPOCH} terminal records for ${baseRequestId}`);
}

export async function ensureSandboxForTask(
  task: DbTask,
  opts?: { pollTimeoutMs?: number; profileId?: string },
): Promise<EnsureSandboxResult> {
  const requestId = sandboxRequestId(task.id);
  let existing = await getTaskSandbox(task.id);

  // H1 key continuity: a ready/stopped mapping is only usable when the
  // in-memory keypair survives (same process). After a service restart the
  // instance is unreachable — recycle (release + fresh create with a new
  // key) instead of wedging the task on a sandbox nobody can enter.
  if (existing && (existing.state === "ready" || existing.state === "stopped") && !hasTaskSshKeypair(task.id)) {
    logger.warn({ taskId: task.id, sandboxId: existing.sandbox_id, state: existing.state }, "Task ssh keypair lost (service restart); recycling sandbox instance");
    try {
      await releaseSandboxPlaneSandbox(existing.sandbox_id);
    } catch (error) {
      logger.warn({ taskId: task.id, sandboxId: existing.sandbox_id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Key-recycle release failed; reconciler will finish it");
    }
    await deleteTaskSandbox(task.id);
    existing = null;
  }

  // Continue/resume path: a stopped instance comes back instead of a new one.
  if (existing && (existing.state === "ready" || existing.state === "stopped")) {
    if (existing.state === "stopped") {
      const resumed = await resumeSandboxPlaneSandbox(existing.sandbox_id);
      if (resumed.status !== "running") await pollUntilRunning(existing.sandbox_id, opts?.pollTimeoutMs ?? CREATE_POLL_TIMEOUT_MS);
      const ready = (await getSandboxPlaneSandbox(existing.sandbox_id)) ?? resumed;
      await updateTaskSandboxState(task.id, "ready");
      logger.info({ taskId: task.id, sandboxId: existing.sandbox_id }, "Sandbox resumed for task");
      return { mapping: { ...existing, state: "ready", ssh_host: ready.ssh?.host ?? existing.ssh_host, ssh_port: ready.ssh?.port ?? existing.ssh_port, ssh_user: ready.ssh?.user ?? existing.ssh_user }, reused: true };
    }
    return { mapping: existing, reused: true };
  }

  // Selection snapshot comes from the Prepare result recorded in metadata.
  // The selection is resolved ONCE by the scheduler gate (fresh prepare
  // result ?? persisted metadata) and passed in explicitly: the in-memory
  // task object can predate prepare persistence (P0-2, 2026-07-18 — gate saw
  // the fresh value while this re-read the stale copy and threw). The
  // metadata fallback remains only for non-scheduler callers/tests.
  const prepare = (task.metadata as Record<string, unknown> | undefined)?.prepare as { sandbox_type?: string | null } | undefined;
  const profileId = opts?.profileId ?? prepare?.sandbox_type ?? undefined;
  if (!profileId) throw new Error("Sandbox allocation requested without a Prepare sandbox_type selection");

  const profile = await getSandboxPlaneProfile(profileId);
  if (!profile) throw new Error(`Prepare selected sandbox type '${profileId}' but SandboxPlane no longer has it`);
  const request = {
    cpu: profile.default_resources?.cpu ?? 0,
    memory_mb: profile.default_resources?.memory_mb ?? 0,
  };

  await assertQuotaForTask(task, request);

  const { publicKeyOpenSsh } = ensureTaskSshKeypair(task.id);
  const { sandbox: createdRecord, requestId: effectiveRequestId } = await createSkippingTerminalReplays(requestId, (rid) => ({
    request_id: rid,
    profile_id: profileId,
    ssh_public_key: publicKeyOpenSsh,
    external_ref: task.id,
  }));

  // Idempotent replay: the same (consumer, request_id) returns the existing
  // record — possibly already running or stopped from a previous attempt.
  let sandbox = createdRecord;
  if (sandbox.status === "stopped") {
    sandbox = await resumeSandboxPlaneSandbox(sandbox.sandbox_id);
  }
  if (sandbox.status !== "running") {
    sandbox = await pollUntilRunning(sandbox.sandbox_id, opts?.pollTimeoutMs ?? CREATE_POLL_TIMEOUT_MS);
  }

  await upsertTaskSandbox({
    task_id: task.id,
    sandbox_id: sandbox.sandbox_id,
    request_id: effectiveRequestId,
    profile_id: profileId,
    cpu_cores: sandbox.resources?.cpu ?? request.cpu,
    memory_mb: sandbox.resources?.memory_mb ?? request.memory_mb,
    ssh_host: sandbox.ssh?.host ?? null,
    ssh_port: sandbox.ssh?.port ?? null,
    ssh_user: sandbox.ssh?.user ?? null,
    state: "ready",
  });
  const mapping = (await getTaskSandbox(task.id))!;
  logger.info({ taskId: task.id, sandboxId: sandbox.sandbox_id, profileId, reused: createdRecord.status === "running" }, "Sandbox allocated for task");
  return { mapping, reused: createdRecord.status === "running" };
}

// ---------------------------------------------------------------------------
// Stop / release transitions (H2 §4)
// ---------------------------------------------------------------------------
export async function stopSandboxForTask(taskId: string, reason = "task_terminal"): Promise<void> {
  const mapping = await getTaskSandbox(taskId);
  if (!mapping || mapping.state !== "ready") return;
  try {
    await stopSandboxPlaneSandbox(mapping.sandbox_id);
    await updateTaskSandboxState(taskId, "stopped");
    dropTaskSshKeypair(taskId);
    logger.info({ taskId, sandboxId: mapping.sandbox_id, reason }, "Sandbox stopped (kept, not destroyed)");
  } catch (error) {
    // Never block task finalization on a stop failure — the reconciler retries.
    logger.warn({ taskId, sandboxId: mapping.sandbox_id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Sandbox stop failed; reconciler will retry");
  }
}

/**
 * Release on task delete (H2 §4 strict order caller side: worker stopped
 * first, then this, then mapping row + task row). A failed release marks the
 * mapping `releasing` so the reconciler finishes it — deletion is not blocked.
 */
/** Resume a stopped sandbox before the task itself resumes (pause ⇄ resume). */
export async function resumeSandboxForTask(taskId: string): Promise<void> {
  const mapping = await getTaskSandbox(taskId);
  if (!mapping || mapping.state !== "stopped") return;
  const resumed = await resumeSandboxPlaneSandbox(mapping.sandbox_id);
  if (resumed.status !== "running") {
    await pollUntilRunning(mapping.sandbox_id, CREATE_POLL_TIMEOUT_MS);
  }
  await updateTaskSandboxState(taskId, "ready");
  logger.info({ taskId, sandboxId: mapping.sandbox_id }, "Sandbox resumed");
}

export async function releaseSandboxForTask(taskId: string): Promise<void> {
  const mapping = await getTaskSandbox(taskId);
  if (!mapping) return;
  if (mapping.state === "released") {
    await deleteTaskSandbox(taskId);
    return;
  }
  try {
    await releaseSandboxPlaneSandbox(mapping.sandbox_id);
    await updateTaskSandboxState(taskId, "released");
    await deleteTaskSandbox(taskId);
    dropTaskSshKeypair(taskId);
    logger.info({ taskId, sandboxId: mapping.sandbox_id }, "Sandbox released and mapping removed");
  } catch (error) {
    await updateTaskSandboxState(taskId, "releasing", error instanceof Error ? error.message : "release failed");
    logger.warn({ taskId, sandboxId: mapping.sandbox_id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Sandbox release failed; marked releasing for reconciler");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reconciler (H2 §5): startup full pass + 60s incremental from the scheduler.
// ---------------------------------------------------------------------------
export async function reconcileSandboxes(): Promise<void> {
  // Rule 2: task row gone but mapping/instance remain → release, then drop row.
  for (const orphan of await listTaskSandboxesWithMissingTask()) {
    try {
      if (orphan.state !== "released") {
        await releaseSandboxPlaneSandbox(orphan.sandbox_id).catch((error) => {
          logger.warn({ taskId: orphan.task_id, sandboxId: orphan.sandbox_id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Orphan release call failed; will retry");
          throw error;
        });
      }
      await deleteTaskSandbox(orphan.task_id);
      dropTaskSshKeypair(orphan.task_id);
      logger.warn({ taskId: orphan.task_id, sandboxId: orphan.sandbox_id }, "Released sandbox of deleted task");
    } catch {
      // keep the row; next pass retries
    }
  }

  // Rule 3: task terminal but instance still ready → catch-up stop.
  for (const mapping of await listReadySandboxesOfTerminalTasks()) {
    await stopSandboxForTask(mapping.task_id, "reconcile_terminal_stop");
  }

  // Rule 1: active mappings whose instance vanished/terminated → failed (+ blocked).
  for (const mapping of await listActiveTaskSandboxes()) {
    if (mapping.state === "releasing") {
      // A release that failed earlier — retry it now.
      try {
        await releaseSandboxPlaneSandbox(mapping.sandbox_id);
        await updateTaskSandboxState(mapping.task_id, "released");
        await deleteTaskSandbox(mapping.task_id);
        dropTaskSshKeypair(mapping.task_id);
        logger.info({ taskId: mapping.task_id, sandboxId: mapping.sandbox_id }, "Retried release succeeded");
      } catch (error) {
        logger.warn({ taskId: mapping.task_id, sandboxId: mapping.sandbox_id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Release retry failed");
      }
      continue;
    }
    try {
      const instance = await getSandboxPlaneSandbox(mapping.sandbox_id);
      if (!instance || PLANE_TERMINAL_STATUSES.has(instance.status)) {
        await updateTaskSandboxState(mapping.task_id, "failed", "instance_lost");
        dropTaskSshKeypair(mapping.task_id);
        const blocked = await blockPendingDynamicStates(mapping.task_id);
        logger.warn(
          { taskId: mapping.task_id, sandboxId: mapping.sandbox_id, plane_status: instance?.status ?? "missing", blocked },
          "Sandbox instance lost; mapping marked failed, pending dynamic states blocked",
        );
      } else if (instance.status === "stopped" && mapping.state === "ready") {
        // Someone stopped it externally — align our view.
        await updateTaskSandboxState(mapping.task_id, "stopped");
      } else if (instance.status === "running" && mapping.state === "creating") {
        await updateTaskSandboxState(mapping.task_id, "ready");
      }
    } catch (error) {
      if (error instanceof SandboxPlaneUnavailableError) {
        logger.debug({ err: error.message }, "SandboxPlane unreachable during reconcile; skipping pass");
        return;
      }
      logger.warn({ taskId: mapping.task_id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Sandbox reconcile entry failed");
    }
  }
}
