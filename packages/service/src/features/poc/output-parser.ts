/**
 * POC Output Parser — parses eval worker outputs after container exit.
 * Reads result.json + poc.sh + screenshots from workspace, uploads to MinIO,
 * and upserts poc_results.
 */

import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { uploadFile } from "../../infra/minio/client.js";
import * as pocStorage from "./storage.js";
import { logger } from "../../infra/logger.js";
import type { ServiceConfig } from "../../infra/config.js";
import { getEvalHostWorkDir } from "./eval-worker.js";
import { getRunHostWorkDir } from "./poc-runner.js";

/**
 * Parse eval worker outputs after container exit.
 * Scans output_dir/findings/<BUG-ID>/ for result.json, poc.sh, screenshots.
 */
export async function syncAndParsePocOutputs(
  jobId: string,
  config: ServiceConfig,
): Promise<number> {
  const job = await pocStorage.getPocJob(jobId);
  if (!job) throw new Error(`POC job ${jobId} not found`);

  const hostWorkDir = getEvalHostWorkDir(config.dataDir, jobId);
  const findingsDir = join(hostWorkDir, "out", "findings");

  if (!existsSync(findingsDir)) {
    logger.warn({ jobId }, "No findings output directory");
    return 0;
  }

  const bucket = config.minio.bucket;
  let parsedCount = 0;

  // Iterate over BUG-* directories
  const entries = readdirSync(findingsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const findingKey = entry.name;
    const findingDir = join(findingsDir, findingKey);

    try {
      const resultPath = join(findingDir, "result.json");
      if (!existsSync(resultPath)) {
        logger.warn({ jobId, findingKey }, "No result.json — skipping");
        continue;
      }

      const resultRaw = readFileSync(resultPath, "utf-8");
      const result = JSON.parse(resultRaw) as {
        bug_id: string;
        status: string;
        evidence?: string;
        endpoint?: string;
        reproduction_steps?: string[];
        [key: string]: unknown;
      };

      // Map status to DB enum
      const statusMap: Record<string, string> = {
        REPRODUCED: "reproduced",
        PARTIALLY_REPRODUCED: "partial",
        NOT_REPRODUCED: "not_reproduced",
        SKIPPED: "skipped",
      };
      const status = statusMap[result.status] ?? "error";

      // Upload poc.sh
      let pocScriptKey: string | undefined;
      const pocScriptPath = join(findingDir, "poc.sh");
      if (existsSync(pocScriptPath)) {
        pocScriptKey = `poc-outputs/${job.task_id}/${jobId}/${findingKey}/poc.sh`;
        const content = readFileSync(pocScriptPath);
        await uploadFile(bucket, pocScriptKey, content, content.length);
      }

      // Upload result.json
      let resultJsonKey: string | undefined;
      resultJsonKey = `poc-outputs/${job.task_id}/${jobId}/${findingKey}/result.json`;
      const resultContent = readFileSync(resultPath);
      await uploadFile(bucket, resultJsonKey, resultContent, resultContent.length);

      // Upload run.log
      let runLogKey: string | undefined;
      const runLogPath = join(findingDir, "run.log");
      if (existsSync(runLogPath)) {
        runLogKey = `poc-outputs/${job.task_id}/${jobId}/${findingKey}/run.log`;
        const logContent = readFileSync(runLogPath);
        await uploadFile(bucket, runLogKey, logContent, logContent.length);
      }

      // Upload screenshots
      let screenshotsPrefix: string | undefined;
      const screenshotFiles = readdirSync(findingDir).filter(
        (f) => f.endsWith(".png") || f.endsWith(".jpg") || f.endsWith(".jpeg"),
      );
      if (screenshotFiles.length > 0) {
        screenshotsPrefix = `poc-outputs/${job.task_id}/${jobId}/${findingKey}/`;
        for (const sf of screenshotFiles) {
          const sfPath = join(findingDir, sf);
          const sfContent = readFileSync(sfPath);
          await uploadFile(bucket, `${screenshotsPrefix}${sf}`, sfContent, sfContent.length);
        }
      }

      // Upsert result to DB
      await pocStorage.upsertPocResult({
        taskId: job.task_id,
        jobId: job.id,
        findingKey,
        status,
        pocScriptMinioKey: pocScriptKey,
        resultJsonMinioKey: resultJsonKey,
        runLogMinioKey: runLogKey,
        screenshotsPrefix,
        targetUrl: job.target_url ?? undefined,
        exitCode: status === "reproduced" ? 0 : status === "error" ? 1 : undefined,
        summary: result.evidence ?? `${result.status}`,
        evidence: result as Record<string, unknown>,
      });

      parsedCount++;
      logger.info({ jobId, findingKey, status }, "POC result parsed and uploaded");
    } catch (err) {
      logger.error({ err, jobId, findingKey }, "Failed to parse POC result");

      // Mark as error
      await pocStorage.upsertPocResult({
        taskId: job.task_id,
        jobId: job.id,
        findingKey,
        status: "error",
        summary: String(err),
      });
    }
  }

  // Upload reproduction-report if exists
  const reportJsonPath = join(hostWorkDir, "out", "reproduction-report.json");
  if (existsSync(reportJsonPath)) {
    const content = readFileSync(reportJsonPath);
    const key = `poc-outputs/${job.task_id}/${jobId}/reproduction-report.json`;
    await uploadFile(bucket, key, content, content.length);
  }
  const reportMdPath = join(hostWorkDir, "out", "reproduction-report.md");
  if (existsSync(reportMdPath)) {
    const content = readFileSync(reportMdPath);
    const key = `poc-outputs/${job.task_id}/${jobId}/reproduction-report.md`;
    await uploadFile(bucket, key, content, content.length);
  }

  return parsedCount;
}

/**
 * Parse POC run outputs after runner container exit.
 * Updates poc_runs row with log key and exit code.
 */
export async function syncPocRunOutput(
  runId: string,
  exitCode: number | undefined,
  config: ServiceConfig,
): Promise<void> {
  const run = await pocStorage.getPocRun(runId);
  if (!run) return;

  const hostWorkDir = getRunHostWorkDir(config.dataDir, runId);
  const bucket = config.minio.bucket;

  // Upload run.log
  let runLogKey: string | undefined;
  const runLogPath = join(hostWorkDir, "run.log");
  if (existsSync(runLogPath)) {
    runLogKey = `poc-runs/${run.task_id}/${run.finding_key}/${runId}/run.log`;
    const content = readFileSync(runLogPath);
    await uploadFile(bucket, runLogKey, content, content.length);
  }

  // Upload events
  let eventsKey: string | undefined;
  const eventsDir = join(hostWorkDir, "events");
  if (existsSync(eventsDir)) {
    const eventFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".service.jsonl"));
    if (eventFiles.length > 0) {
      eventsKey = `poc-runs/${run.task_id}/${run.finding_key}/${runId}/events.jsonl`;
      // Concat all event files
      let allEvents = "";
      for (const ef of eventFiles) {
        allEvents += readFileSync(join(eventsDir, ef), "utf-8");
      }
      const buf = Buffer.from(allEvents, "utf-8");
      await uploadFile(bucket, eventsKey, buf, buf.length);
    }
  }

  const ok = exitCode === 0;
  await pocStorage.updatePocRunState(runId, ok ? "completed" : "failed", {
    exitCode,
    completedAt: new Date(),
    durationMs: run.started_at ? Date.now() - new Date(run.started_at).getTime() : undefined,
    runLogMinioKey: runLogKey,
    eventsMinioKey: eventsKey,
    failureReason: ok ? undefined : `Runner exited with code ${exitCode}`,
  });

  logger.info({ runId, exitCode, findingKey: run.finding_key }, "POC run output synced");
}
