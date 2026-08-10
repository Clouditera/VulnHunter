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
  SandboxPlaneTimeoutError,
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
  updateTaskSandboxConnection,
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
/** Resume POST may abort while plane still brings the container up — poll window. */
const RESUME_RECONCILE_TIMEOUT_MS = 60_000;

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

/**
 * 051 persistence (fish-approved): the private key is vault-encrypted onto the
 * task_sandboxes mapping row, so it survives service restarts/upgrades.
 * Read chain: memory -> DB decrypt (+ rehydrate memory) -> caller generates.
 * Decrypt failure (master key lost/rotated) returns false and the caller
 * falls back to the recycle path (degraded, never wedged).
 * Plaintext still never touches disk/env/logs — only the vault ciphertext
 * lives in DB, and it dies with the mapping row on release.
 */

/** Persist the in-memory keypair (vault-encrypted) onto the mapping row. */
export async function storeTaskSshKeypair(taskId: string): Promise<void> {
  const entry = sshKeys.get(taskId);
  if (!entry) return;
  const { getVaultOptional } = await import("../settings/storage.js");
  const vault = getVaultOptional();
  if (!vault) {
    logger.warn({ taskId }, "Master key unavailable — task ssh keypair stays memory-only (restart resilience degraded)");
    return;
  }
  const { updateTaskSandboxSshKey } = await import("./storage.js");
  const encrypted = vault.encrypt(entry.privateKeyOpenSsh);
  await updateTaskSandboxSshKey(taskId, {
    ciphertext: encrypted.ciphertext as Buffer,
    iv: encrypted.iv as Buffer,
    tag: encrypted.tag as Buffer,
  });
}

/** Memory -> DB decrypt -> rehydrate. False when unavailable or undecryptable. */
export async function loadTaskSshKeypair(taskId: string): Promise<boolean> {
  if (sshKeys.has(taskId)) return true;
  const mapping = await getTaskSandbox(taskId);
  if (!mapping?.ssh_key_ciphertext || !mapping.ssh_key_iv || !mapping.ssh_key_tag) return false;
  try {
    const { getVaultOptional } = await import("../settings/storage.js");
    const vault = getVaultOptional();
    if (!vault) return false;
    const privateKeyOpenSsh = vault.decrypt({
      ciphertext: mapping.ssh_key_ciphertext,
      iv: mapping.ssh_key_iv,
      tag: mapping.ssh_key_tag,
    });
    // Public half is derivable from the OpenSSH private blob; store the pair
    // shape consumers expect (public used only for plane create, not resume).
    const publicKeyOpenSsh = publicFromOpenSshPrivate(privateKeyOpenSsh);
    sshKeys.set(taskId, { publicKeyOpenSsh, privateKeyOpenSsh });
    return true;
  } catch (err) {
    logger.warn({ err, taskId }, "Task ssh keypair decrypt failed (master key issue); recycle path applies");
    return false;
  }
}

/** Extract the public key line from an openssh-key-v1 private blob. */
function publicFromOpenSshPrivate(privateKeyOpenSsh: string): string {
  const body = Buffer.from(
    privateKeyOpenSsh.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  // Layout: "openssh-key-v1\0" + 3 strings + uint32 nkeys + string public-blob
  let off = "openssh-key-v1\0".length;
  const readStr = (): Buffer => {
    const len = body.readUInt32BE(off);
    off += 4;
    const out = body.subarray(off, off + len);
    off += len;
    return out;
  };
  readStr(); readStr(); readStr(); // ciphername, kdfname, kdfoptions
  off += 4; // nkeys
  const publicBlob = readStr();
  return `ssh-ed25519 ${publicBlob.toString("base64")}`;
}

/** H1 handoff: the OpenSSH private key file content for worker tmpfs injection. */
export async function peekTaskSshPrivateKey(taskId: string): Promise<string | null> {
  if (await loadTaskSshKeypair(taskId)) {
    return sshKeys.get(taskId)?.privateKeyOpenSsh ?? null;
  }
  return null;
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

/**
 * Resume path: fire POST resume, then always reconcile via GET poll.
 * fish/architect 2026-08-10: POST abort does NOT mean plane failed — container
 * may still come up. Only HTTP errors (4xx/5xx via SandboxPlaneUnavailableError)
 * fail fast without empty-waiting. Timeout → poll until running or deadline.
 */
async function resumeAndReconcile(
  sandboxId: string,
  pollTimeoutMs: number = RESUME_RECONCILE_TIMEOUT_MS,
): Promise<SandboxPlaneSandbox> {
  let postResult: SandboxPlaneSandbox | null = null;
  try {
    postResult = await resumeSandboxPlaneSandbox(sandboxId);
    if (postResult.status === "running") return postResult;
  } catch (err) {
    if (err instanceof SandboxPlaneTimeoutError) {
      logger.warn(
        { sandboxId, timeoutMs: err.timeoutMs },
        "Sandbox resume POST timed out; polling plane status (POST may still complete)",
      );
    } else {
      // HTTP / capacity / true unavailability — do not empty-wait
      throw err;
    }
  }
  return pollUntilRunning(sandboxId, pollTimeoutMs);
}

/**
 * Merge plane SSH endpoint into mapping, persist to task_sandboxes, warn on change.
 * Missing plane ssh fields keep prior values (architect 2026-08-10).
 */
async function persistResumeEndpoint(
  taskId: string,
  prior: Pick<
    TaskSandbox,
    "ssh_host" | "ssh_port" | "ssh_user" | "ssh_internal_host" | "ssh_host_public_key" | "sandbox_id"
  >,
  plane: SandboxPlaneSandbox,
): Promise<{
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  ssh_internal_host: string | null;
  ssh_host_public_key: string | null;
}> {
  const next = {
    ssh_host: plane.ssh?.host ?? prior.ssh_host,
    ssh_port: plane.ssh?.port ?? prior.ssh_port,
    ssh_user: plane.ssh?.user ?? prior.ssh_user,
    ssh_internal_host: plane.ssh_internal_host ?? prior.ssh_internal_host,
    ssh_host_public_key: plane.ssh_host_public_key ?? prior.ssh_host_public_key,
  };

  const hostChanged = next.ssh_host !== prior.ssh_host;
  const portChanged = next.ssh_port !== prior.ssh_port;
  if (hostChanged || portChanged) {
    logger.warn(
      {
        taskId,
        sandboxId: prior.sandbox_id,
        old_host: prior.ssh_host,
        old_port: prior.ssh_port,
        new_host: next.ssh_host,
        new_port: next.ssh_port,
      },
      "sandbox connection endpoint changed after resume",
    );
  }

  // Only push fields plane actually provided (null plane ssh → COALESCE keeps DB).
  await updateTaskSandboxConnection(taskId, {
    ssh_host: plane.ssh?.host ?? null,
    ssh_port: plane.ssh?.port ?? null,
    ssh_user: plane.ssh?.user ?? null,
    ssh_internal_host: plane.ssh_internal_host ?? null,
    ssh_host_public_key: plane.ssh_host_public_key ?? null,
  });

  return next;
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
  if (existing && (existing.state === "ready" || existing.state === "stopped") && !(await loadTaskSshKeypair(task.id))) {
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
      const ready = await resumeAndReconcile(
        existing.sandbox_id,
        opts?.pollTimeoutMs ?? RESUME_RECONCILE_TIMEOUT_MS,
      );
      const endpoint = await persistResumeEndpoint(task.id, existing, ready);
      await updateTaskSandboxState(task.id, "ready");
      logger.info({ taskId: task.id, sandboxId: existing.sandbox_id }, "Sandbox resumed for task");
      return {
        mapping: {
          ...existing,
          state: "ready",
          ...endpoint,
        },
        reused: true,
      };
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
    sandbox = await resumeAndReconcile(
      sandbox.sandbox_id,
      opts?.pollTimeoutMs ?? RESUME_RECONCILE_TIMEOUT_MS,
    );
  } else if (sandbox.status !== "running") {
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
    ssh_internal_host: sandbox.ssh_internal_host ?? null,
    ssh_host_public_key: sandbox.ssh_host_public_key ?? null,
    state: "ready",
  });
  await storeTaskSshKeypair(task.id).catch((err) =>
    logger.warn({ err, taskId: task.id }, "Failed to persist task ssh keypair (restart resilience degraded)"),
  );
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
  const ready = await resumeAndReconcile(mapping.sandbox_id, RESUME_RECONCILE_TIMEOUT_MS);
  await persistResumeEndpoint(taskId, mapping, ready);
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
