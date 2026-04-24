/**
 * POC Job Scheduler — polls queued poc_jobs and poc_runs, spawns containers.
 * Also handles container die events.
 */

import { join } from "node:path";
import { logger } from "../../infra/logger.js";
import * as pocStorage from "./storage.js";
import { spawnEvalWorker, getEvalHostWorkDir } from "./eval-worker.js";
import { spawnPocRunner, getRunHostWorkDir } from "./poc-runner.js";
import { syncAndParsePocOutputs, syncPocRunOutput } from "./output-parser.js";
import { startTailing } from "../events/event-tail.js";
import { notify } from "../notifications/index.js";
import type { ServiceConfig } from "../../infra/config.js";

/**
 * Tick function called by TaskScheduler on each interval.
 * Polls for queued POC jobs and runs.
 */
export async function tickPocScheduler(config: ServiceConfig): Promise<void> {
  // Check queued jobs
  const queuedJobs = await pocStorage.getQueuedPocJobs(1);
  for (const job of queuedJobs) {
    try {
      await pocStorage.updatePocJobState(job.id, "preparing");
      await spawnEvalWorker(job, config);

      // Start tailing event files
      const hostWorkDir = getEvalHostWorkDir(config.dataDir, job.id);
      const eventsDir = join(hostWorkDir, "out", ".youngflow", "logs");
      startTailing(job.id, [], [{ path: eventsDir, source: `poc:${job.id}` }]);
    } catch (err) {
      logger.error({ err, jobId: job.id }, "Failed to spawn eval worker");
      await pocStorage.updatePocJobState(job.id, "failed", {
        completedAt: new Date(),
        failureReason: String(err),
      });
      notify({ type: "task_state", taskId: job.task_id, state: "completed" as never });
    }
  }

  // Check queued runs
  const queuedRuns = await pocStorage.getQueuedPocRuns(1);
  for (const run of queuedRuns) {
    try {
      await spawnPocRunner(run, config);

      // Start tailing event files
      const hostWorkDir = getRunHostWorkDir(config.dataDir, run.id);
      const eventsDir = join(hostWorkDir, "events");
      startTailing(run.id, [], [{ path: eventsDir, source: `poc:${run.id}` }]);
    } catch (err) {
      logger.error({ err, runId: run.id }, "Failed to spawn POC runner");
      await pocStorage.updatePocRunState(run.id, "failed", {
        completedAt: new Date(),
        failureReason: String(err),
      });
    }
  }
}

/**
 * Handle eval worker container die event.
 * Parse outputs → upsert results → update job state.
 */
export async function onEvalContainerDie(
  jobId: string,
  exitCode: number | undefined,
  config: ServiceConfig,
): Promise<void> {
  const job = await pocStorage.getPocJob(jobId);
  if (!job) return;

  const ok = exitCode === 0;

  if (ok) {
    try {
      const count = await syncAndParsePocOutputs(jobId, config);
      logger.info({ jobId, count }, "POC outputs parsed");
    } catch (err) {
      logger.error({ err, jobId }, "Failed to parse POC outputs");
    }
  }

  const durationMs = job.started_at
    ? Date.now() - new Date(job.started_at).getTime()
    : undefined;

  await pocStorage.updatePocJobState(jobId, ok ? "completed" : "failed", {
    completedAt: new Date(),
    durationMs,
    failureReason: ok ? undefined : `Eval worker exited with code ${exitCode}`,
  });

  notify({ type: "task_state", taskId: job.task_id, state: "completed" as never });
  logger.info({ jobId, exitCode }, "Eval worker completed");
}

/**
 * Handle POC run container die event.
 * Sync run output + update state.
 */
export async function onPocRunContainerDie(
  runId: string,
  exitCode: number | undefined,
  config: ServiceConfig,
): Promise<void> {
  await syncPocRunOutput(runId, exitCode, config);
}
