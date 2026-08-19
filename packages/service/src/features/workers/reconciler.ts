/**
 * Startup reconciler — aligns Docker container state with DB task state.
 * Runs once at service boot (K8s controller pattern).
 */

import { logger } from "../../infra/logger.js";
import {
  listManagedContainers,
  getDocker,
  LABEL_TASK_ID,
  LABEL_TASK_TYPE,
  LABEL_SCHEDULER_CLAIM,
} from "./docker-client.js";
import {
  getSchedulerClaim,
  getTaskById,
  listPreparingSchedulerClaims,
  markSchedulerClaimRunning,
  releaseExpiredSchedulerClaim,
  updateTaskState,
} from "../tasks/storage.js";
import { SCAN_FALLBACK_MARGIN_S } from "../tasks/scan-duration.js";
import { getDb } from "../../infra/db/client.js";
import { loadConfig } from "../../infra/config.js";
import { getHostWorkDir, stopScanWorkerByClaim } from "./scan-worker.js";
import { cleanupSchedulerWorkspace } from "./scheduler-workspace.js";
import { load as yamlLoad } from "js-yaml";
import { isDynamicEnabled } from "../prepare/contract.js";
import { startTailing } from "../events/event-tail.js";
import { reconcileSandboxes } from "../sandboxes/lifecycle.js";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { failSchedulerClaim, mergeTaskMetadata } from "../tasks/storage.js";
import { notify } from "../notifications/index.js";

/** Read extracted.onboard.next from the engine's persisted checkpoint. */
function readCheckpointGateNext(checkpointPath: string): "continue" | "end" | null {
  try {
    const data = yamlLoad(readFileSync(checkpointPath, "utf8")) as Record<string, unknown> | null;
    const extracted = (data?.extracted ?? null) as Record<string, unknown> | null;
    const onboard = (extracted?.onboard ?? null) as Record<string, unknown> | null;
    const next = onboard?.next;
    return next === "continue" || next === "end" ? next : null;
  } catch {
    return null;
  }
}

/** Gate evidence file check (mirrors the scheduler's checkGateEvidence). */
function checkGateEvidenceFiles(task: { source_meta?: Record<string, unknown> | null; metadata?: unknown }, hostWorkDir: string): string[] {
  const missing: string[] = [];
  const outDir = join(hostWorkDir, "out");
  for (const rel of ["knowledge/profiler.yaml", "knowledge/wiki/index.md", "knowledge/wiki/overview.md", "knowledge/wiki/threat-model.md"]) {
    const p = join(outDir, ...rel.split("/"));
    if (!(existsSync(p) && statSync(p).size > 0)) missing.push(rel);
  }
  if (isDynamicEnabled(task as never)) {
    const alloc = (((task.metadata as Record<string, unknown> | undefined)?.sandbox_alloc ?? null) as { sandbox_id?: string } | null);
    if (!alloc?.sandbox_id) missing.push("sandbox_alloc");
  }
  return missing;
}

export async function reconcileSchedulerClaims(config = loadConfig()): Promise<void> {
  const containers = await listManagedContainers();
  const preparing = await listPreparingSchedulerClaims(200);
  for (const task of preparing) {
    const claim = task.scheduler_claim;
    const matching = containers.filter((c) =>
      c.Labels?.[LABEL_TASK_TYPE] === "scan" && c.Labels?.[LABEL_TASK_ID] === task.id
      && c.Labels?.[LABEL_SCHEDULER_CLAIM] === claim.token,
    );
    const running = matching.find((c) => c.State === "running" || c.State === "paused");
    if (running) {
      if (claim.mode === "fresh") {
        // Engine-native gate: a fresh claim's worker runs the gate IN the
        // container; the route-event handler (EventTail) owns the
        // preparing→running transition. After a service restart the handler
        // is gone, so perception falls to the engine's own persisted
        // checkpoint (out/.youngflow/checkpoints/flow_state.yaml,
        // extracted.onboard.next — the same data the engine saves when
        // routing):
        //   continue + evidence present → adopt (CAS running)
        //   end → finalize dead via gate.yaml
        //   absent → re-arm: adopt path below re-attaches tailing and the
        //            scheduler-side handler is re-registered on next claim.
        const hostWorkDir = getHostWorkDir(config.dataDir, task.id);
        const gateNext = readCheckpointGateNext(join(hostWorkDir, "out", ".youngflow", "checkpoints", "flow_state.yaml"));
        if (gateNext === "end") {
          if (await failSchedulerClaim(task.id, claim.token, JSON.stringify({
            code: "ERR_PREPARE_FAILED",
            message: "Onboard gate END (restart reconcile)",
            details: { phase: "prepare", source: "checkpoint" },
          }))) {
            await stopScanWorkerByClaim(task.id, claim.token);
            notify({ type: "task_state", taskId: task.id, state: "failed" });
          }
          continue;
        }
        if (gateNext !== "continue") {
          // Gate not yet routed (or checkpoint unreadable): keep preparing —
          // the re-armed EventTail handler + max_loops/deadline bounds own it.
          logger.info({ taskId: task.id, token: claim.token, gateNext }, "Fresh claim worker in gate phase (checkpoint); leaving for route perception");
          continue;
        }
        // gateNext === continue": adopt only with evidence (same gate as the
        // live path — decide cannot self-authorize across restarts either).
        const missing = checkGateEvidenceFiles(task, hostWorkDir);
        if (missing.length > 0) {
          if (await failSchedulerClaim(task.id, claim.token, JSON.stringify({
            code: "ERR_PREPARE_FAILED",
            message: `门禁证据缺失：${missing.join("、")}`,
            details: { phase: "prepare", reason: "gate_evidence_missing", source: "restart" },
          }))) {
            await stopScanWorkerByClaim(task.id, claim.token);
            notify({ type: "task_state", taskId: task.id, state: "failed" });
          }
          continue;
        }
        await mergeTaskMetadata(task.id, {
          prepare: {
            project_complete: true,
            sandbox_type: null,
            reason: "complete",
            at: new Date().toISOString(),
          },
        }).catch(() => undefined);
        // fall through to adopt (markSchedulerClaimRunning + tailing)
      }
      if (await markSchedulerClaimRunning(task.id, claim.token, new Date())) {
        const hostWorkDir = getHostWorkDir(config.dataDir, task.id);
        try {
          startTailing(task.id, [], [
            { path: join(hostWorkDir, "out", ".youngflow", "logs"), source: "scan" },
            { path: join(hostWorkDir, ".service-logs"), source: "scan" },
          ]);
        } catch (err) {
          logger.warn({ err, taskId: task.id, token: claim.token }, "Adopted Worker but event tailing could not start");
        }
        logger.info({ taskId: task.id, token: claim.token, containerId: running.Id }, "Adopted running claim Worker");
      }
      continue;
    }
    // H3 §3: the claim's deadline_at expiry must carry the same stuck-margin
    // (SCAN_FALLBACK_MARGIN_S) as the platform fallback. The timeout LLM
    // finalizer is retired (2026-08-18): the worker writes the platform
    // timeout marker directly at deadline exit, so the margin only covers the
    // deadline runner's 30s grace + scheduler slack.
    // lease_expires_at is the owner-liveness lease and takes no margin.
    const leaseExpired = Date.parse(claim.lease_expires_at) <= Date.now();
    const deadlineStuck = Date.parse(claim.deadline_at) + SCAN_FALLBACK_MARGIN_S * 1000 <= Date.now();
    const expired = leaseExpired || deadlineStuck;
    if (!expired) continue;
    if (await releaseExpiredSchedulerClaim(task.id, claim.token)) {
      await stopScanWorkerByClaim(task.id, claim.token);
      await cleanupSchedulerWorkspace(getHostWorkDir(config.dataDir, task.id), claim.token).catch((err) =>
        logger.warn({ err, taskId: task.id, token: claim.token }, "Failed to clean expired claim workspace"),
      );
      logger.warn({ taskId: task.id, token: claim.token }, "Released expired scheduler claim");
    }
  }

  for (const c of containers) {
    if (c.Labels?.[LABEL_TASK_TYPE] !== "scan" || !["running", "paused"].includes(c.State)) continue;
    const taskId = c.Labels?.[LABEL_TASK_ID];
    const token = c.Labels?.[LABEL_SCHEDULER_CLAIM];
    if (!taskId) continue;
    const task = await getTaskById(taskId);
    if (task && ["failed", "cancelled", "completed"].includes(task.state)) {
      if (token) await stopScanWorkerByClaim(taskId, token);
      else {
        const container = getDocker().getContainer(c.Id);
        await container.stop({ t: 30 }).catch(() => undefined);
        await container.remove({ force: true }).catch(() => undefined);
      }
      logger.warn({ taskId, token, state: task.state }, "Removed terminal-task running scan orphan");
    }
  }

  for (const c of containers) {
    if (c.Labels?.[LABEL_TASK_TYPE] !== "scan" || ["running", "paused"].includes(c.State)) continue;
    const taskId = c.Labels?.[LABEL_TASK_ID];
    const token = c.Labels?.[LABEL_SCHEDULER_CLAIM];
    if (!taskId) continue;
    const task = await getTaskById(taskId);
    if (task?.state === "preparing") {
      const currentToken = getSchedulerClaim(task)?.token;
      if (currentToken === token) continue;
      logger.error({ taskId, token, currentToken, containerId: c.Id }, "Claim-token mismatch on non-running scan container; refusing cleanup");
      continue;
    }
    if (task?.state === "running") {
      await updateTaskState(taskId, "failed", { completedAt: new Date(), failureReason: "Scan container exited before reconciliation" });
    }
    await getDocker().getContainer(c.Id).remove({ force: true }).catch((err) =>
      logger.warn({ err, taskId, token, containerId: c.Id }, "Failed to remove eligible non-running scan container"),
    );
  }
}

export async function reconcileWorkers(): Promise<void> {
  logger.info("Starting worker reconciliation...");
  await reconcileSchedulerClaims();

  // H2 §5: full sandbox reconcile at boot (release orphans of deleted tasks,
  // catch-up stop for terminal tasks, adopt/fail instance state drift).
  await reconcileSandboxes().catch((err) =>
    logger.error({ err }, "Startup sandbox reconcile failed (will retry on tick)"),
  );

  const containers = await listManagedContainers();

  for (const c of containers) {
    const taskId = c.Labels?.[LABEL_TASK_ID];
    const taskType = c.Labels?.[LABEL_TASK_TYPE];
    if (!taskId) continue;

    const task = await getTaskById(taskId);

    if (!task) {
      // Container not in DB — stale, force remove
      logger.warn({ taskId, containerName: c.Names[0] }, "Stale container (not in DB), removing");
      try {
        logger.info({ containerId: c.Id }, "Force removing stale container");
        // Actual removal handled by docker-client — skipped in reconciler for safety
      } catch {}
      continue;
    }

    const containerRunning = c.State === "running";
    const dbRunning = task.state === "running";

    if (dbRunning && containerRunning) {
      // Good: DB says running, container is running → re-attach event tailing
      const config = loadConfig();
      if (taskType === "scan") {
        const hostWorkDir = getHostWorkDir(config.dataDir, taskId);
        const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
        const serviceLogsDir = join(hostWorkDir, ".service-logs");
        startTailing(taskId, [], [{ path: eventsDir, source: "scan" }, { path: serviceLogsDir, source: "scan" }]);
      }
      logger.info({ taskId, taskType }, "Re-attached to running worker (event tailing started)");
    } else if (dbRunning && !containerRunning) {
      // DB says running, container is dead → mark as failed
      logger.warn({ taskId, exitCode: c.Status }, "Orphaned task (container dead, DB running) → failed");
      await updateTaskState(taskId, "failed", {
        completedAt: new Date(),
        failureReason: "Service restart detected orphaned container",
      });
    }
    // completed/failed/cancelled DB tasks that still have containers → they should be cleaned up
    // by the docker events handler on next event, or will be ignored
  }

  // Find DB tasks that are "running" but have no container
  const db = getDb();
  const runningTasks = await db<{ id: string }[]>`
    SELECT id FROM tasks WHERE state = 'running'
  `;

  const containerTaskIds = new Set(
    containers.map((c) => c.Labels?.[LABEL_TASK_ID]).filter(Boolean),
  );

  for (const { id } of runningTasks) {
    if (!containerTaskIds.has(id)) {
      logger.warn({ taskId: id }, "Running task has no container → failed");
      await updateTaskState(id, "failed", {
        completedAt: new Date(),
        failureReason: "Container missing after service restart",
      });
    }
  }

  // Layer 3: clean up all exited managed containers to prevent name conflicts
  const docker = getDocker();
  for (const c of containers) {
    if (c.State !== "running") {
      const taskId = c.Labels?.[LABEL_TASK_ID];
      const token = c.Labels?.[LABEL_SCHEDULER_CLAIM];
      if (c.Labels?.[LABEL_TASK_TYPE] === "scan" && taskId && token) {
        const current = await getTaskById(taskId);
        if (current?.state === "preparing" && getSchedulerClaim(current)?.token === token) continue;
      }
      try {
        await docker.getContainer(c.Id).remove({ force: true });
        logger.info({ id: c.Id, name: c.Names?.[0] }, "Removed exited managed container");
      } catch { /* already gone */ }
    }
  }

  logger.info("Worker reconciliation complete");
}
