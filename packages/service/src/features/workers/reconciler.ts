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
  failSchedulerClaim,
  getSchedulerClaim,
  getTaskById,
  listPreparingSchedulerClaims,
  markSchedulerClaimRunning,
  mergeTaskMetadata,
  releaseExpiredSchedulerClaim,
  updateTaskState,
} from "../tasks/storage.js";
import { SCAN_FALLBACK_MARGIN_S } from "../tasks/scan-duration.js";
import { getDb } from "../../infra/db/client.js";
import { loadConfig } from "../../infra/config.js";
import { getHostWorkDir, stopScanWorkerByClaim } from "./scan-worker.js";
import { cleanupSchedulerWorkspace } from "./scheduler-workspace.js";
import { load as yamlLoad } from "js-yaml";
import { isDynamicEnabled, parseGateYaml, type GateYaml } from "../prepare/contract.js";
import { startTailing } from "../events/event-tail.js";
import { reconcileSandboxes } from "../sandboxes/lifecycle.js";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { notify } from "../notifications/index.js";
import { appendAndBroadcastCompletionEvent } from "./scheduler-events.js";
import { armGateRouteHandler } from "./gate-perception.js";
import { hasEngineEventHandler } from "../events/event-tail.js";

/** Read + validate gate.yaml from the workspace (same parser as the live path). */
function readGateYamlFile(hostWorkDir: string): GateYaml | null {
  try {
    return parseGateYaml(readFileSync(join(hostWorkDir, "out", "gate.yaml"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Restart-path gate route handler: the checkpoint said the gate had NOT yet
 * routed; when the (re-armed) EventTail delivers the route event, run the
 * same terminal semantics as the scheduler's live handleGateRoute. Kept
 * local to avoid a scheduler import cycle; the logic mirrors it 1:1.
 */
async function restartGateRoute(taskId: string, token: string, hostWorkDir: string, target: string, config: import("../../infra/config.js").ServiceConfig): Promise<void> {
  const current = await getTaskById(taskId).catch(() => null);
  if (!current || current.state !== "preparing") return;
  const claim = getSchedulerClaim(current);
  if (!claim || claim.token !== token) return;
  const gate = readGateYamlFile(hostWorkDir);

  if (target === "exit") {
    const reason = gate?.reason ?? "partial_source";
    const incomplete = reason === "partial_source" || reason === "fragment_collection";
    if (incomplete) await mergeTaskMetadata(taskId, { source_incomplete: true }).catch(() => undefined);
    await mergeTaskMetadata(taskId, {
      prepare: { project_complete: false, sandbox_type: gate?.sandbox_type ?? null, reason, at: new Date().toISOString() },
    }).catch(() => undefined);
    appendAndBroadcastCompletionEvent(taskId, {
      type: "prepare_failed", source: "scan", seq: 0, ts: new Date().toISOString(),
      reason: incomplete ? "source_incomplete" : reason,
      remediation: incomplete ? "请补充完整项目源码后重新创建任务" : "请重试或联系管理员",
      ...(gate?.detail ? { detail: gate.detail } : {}),
    } as never);
    if (await failSchedulerClaim(taskId, token, JSON.stringify({
      code: "ERR_PREPARE_FAILED",
      message: gate?.detail ?? `Onboard gate END (reason=${reason})`,
      details: { phase: "prepare", reason },
    }))) {
      await stopScanWorkerByClaim(taskId, token);
      notify({ type: "task_state", taskId, state: "failed" });
    }
    return;
  }

  // target === cycle_join: evidence gate, then CAS (same as live path).
  const missing = checkGateEvidenceFiles(current, hostWorkDir);
  if (missing.length > 0) {
    if (await failSchedulerClaim(taskId, token, JSON.stringify({
      code: "ERR_PREPARE_FAILED",
      message: `门禁证据缺失：${missing.join("、")}`,
      details: { phase: "prepare", reason: "gate_evidence_missing", source: "restart_route" },
    }))) {
      await stopScanWorkerByClaim(taskId, token);
      notify({ type: "task_state", taskId, state: "failed" });
    }
    return;
  }
  await mergeTaskMetadata(taskId, {
    prepare: {
      project_complete: true,
      sandbox_type: gate?.sandbox_type ?? null,
      reason: "complete",
      at: new Date().toISOString(),
    },
  }).catch(() => undefined);
  appendAndBroadcastCompletionEvent(taskId, {
    type: "prepare_completed", source: "scan", seq: 0, ts: new Date().toISOString(),
    project_complete: true, sandbox_type: gate?.sandbox_type ?? null, reason: "complete",
  });
  if (await markSchedulerClaimRunning(taskId, token, new Date())) {
    notify({ type: "task_state", taskId, state: "running" });
  }
  void config;
}

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
        const gate = readGateYamlFile(hostWorkDir);
        if (gateNext === "end") {
          // Gate verdict END: same terminal semantics as the live path —
          // persist metadata.prepare, emit prepare_failed with the mapped
          // user-facing reason + gate detail, source_incomplete flag, fail
          // claim, stop worker (review r1 nit: timeline parity).
          const incomplete = gate?.reason === "partial_source" || gate?.reason === "fragment_collection";
          if (incomplete) {
            await mergeTaskMetadata(task.id, { source_incomplete: true }).catch(() => undefined);
          }
          await mergeTaskMetadata(task.id, {
            prepare: {
              project_complete: false,
              sandbox_type: gate?.sandbox_type ?? null,
              reason: gate?.reason ?? "partial_source",
              at: new Date().toISOString(),
            },
          }).catch(() => undefined);
          appendAndBroadcastCompletionEvent(task.id, {
            type: "prepare_failed",
            source: "scan",
            seq: 0,
            ts: new Date().toISOString(),
            reason: incomplete ? "source_incomplete" : (gate?.reason ?? "partial_source"),
            remediation: incomplete ? "请补充完整项目源码后重新创建任务" : "请重试或联系管理员",
            ...(gate?.detail ? { detail: gate.detail } : {}),
          } as never);
          if (await failSchedulerClaim(task.id, claim.token, JSON.stringify({
            code: "ERR_PREPARE_FAILED",
            message: gate?.detail ?? `Onboard gate END (reason=${gate?.reason ?? "unknown"})`,
            details: { phase: "prepare", reason: gate?.reason ?? "partial_source", source: "restart" },
          }))) {
            await stopScanWorkerByClaim(task.id, claim.token);
            notify({ type: "task_state", taskId: task.id, state: "failed" });
          }
          continue;
        }
        if (gateNext !== "continue") {
          // Gate not yet routed (or checkpoint unreadable). Re-arm ONLY when
          // unarmed: the live spawn path arms perception in-process, and
          // re-arming an armed task restarts tailing from offset 0 —
          // replaying the whole engine log into the timeline every tick
          // (QA f14c6582 regression, fixed 2026-08-19). After a real restart
          // (handler gone) the first reconcile re-arms once; subsequent
          // ticks skip via this same check. max_loops/deadline bounds still
          // apply if the flow never routes.
          if (hasEngineEventHandler(task.id)) {
            logger.debug({ taskId: task.id, token: claim.token }, "Fresh claim gate perception already armed; skipping re-arm");
            continue;
          }
          logger.info({ taskId: task.id, token: claim.token, gateNext }, "Fresh claim worker in gate phase (checkpoint); re-arming route perception");
          try {
            startTailing(task.id, [], [
              { path: join(hostWorkDir, "out", ".youngflow", "logs"), source: "scan" },
              { path: join(hostWorkDir, ".service-logs"), source: "scan" },
            ]);
          } catch (err) {
            logger.warn({ err, taskId: task.id }, "Reconciler re-arm tailing failed");
          }
          armGateRouteHandler({
            taskId: task.id,
            token: claim.token,
            hostWorkDir,
            onRoute: (target) => {
              restartGateRoute(task.id, claim.token, hostWorkDir, target, config).catch((err) =>
                logger.error({ err, taskId: task.id, target }, "Reconciler gate route handling failed"),
              );
            },
          });
          continue;
        }
        // gateNext === continue: adopt only with evidence (same gate as the
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
            // Dynamic adopt: the allocation basis must survive for a later
            // continue — read it from gate.yaml, same source as the live
            // path (review r1 hole 2: hardcoded null broke continue).
            sandbox_type: gate?.sandbox_type ?? null,
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
