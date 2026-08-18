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
import { persistedPrepareResult } from "../prepare/contract.js";
import { startTailing } from "../events/event-tail.js";
import { reconcileSandboxes } from "../sandboxes/lifecycle.js";
import { join } from "node:path";

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
        // v2 onboard gate: a fresh claim's worker runs the gate INSIDE the
        // container. A running container under preparing+fresh is exactly
        // the expected gate phase — adopting it as running here would skip
        // the gate CAS (the callback owns preparing→running). Only a
        // completed gate (metadata.prepare persisted by the callback before
        // the CAS) may be adopted: that means the callback finished its
        // work and died between persist and CAS — extremely narrow, adopt.
        const gateDone = persistedPrepareResult(
          ((task.metadata as Record<string, unknown> | undefined)?.prepare),
        )?.project_complete === true;
        if (!gateDone) {
          logger.info({ taskId: task.id, token: claim.token }, "Fresh claim worker running in gate phase; leaving for callback");
          continue;
        }
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
    // H3 §3: the claim's deadline_at expiry must carry the same +720s
    // stuck-margin as the platform fallback — a worker adopted during
    // preparation may be running its own bounded finalizer (660s cap), and
    // force-stopping it inside that window would kill the report (form B).
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
