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
} from "./docker-client.js";
import { getTaskById, updateTaskState } from "../tasks/storage.js";
import { getDb } from "../../infra/db/client.js";
import { loadConfig } from "../../infra/config.js";
import { getHostWorkDir } from "./scan-worker.js";
import { startTailing } from "../events/event-tail.js";
import { join } from "node:path";

export async function reconcileWorkers(): Promise<void> {
  logger.info("Starting worker reconciliation...");

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
      try {
        await docker.getContainer(c.Id).remove({ force: true });
        logger.info({ id: c.Id, name: c.Names?.[0] }, "Removed exited managed container");
      } catch { /* already gone */ }
    }
  }

  logger.info("Worker reconciliation complete");
}
