/**
 * POST /internal/prepare-result — worker→service gate callback (plan §4.1/§4.2).
 *
 * The onboard gate (fresh tasks) runs INSIDE the scan worker: the five-step
 * onboarding flow submits its three-field result here when it reaches the
 * gate. The service — still holding the scheduler claim in `preparing` —
 * consumes the result exactly like the retired prepare worker's output file:
 *
 *   failure branches (partial_source / fragment_collection / complete+dynamic
 *   with no compatible sandbox) → fail the claim + stop the worker;
 *
 *   success + dynamic → validate sandbox_type against the plane live, then
 *   allocate (quota/capacity → HTTP 503 + retry_after, the submit script
 *   retries with the same 6×5min backoff semantics), render + inject the
 *   SSH files into the RUNNING worker container, markSchedulerClaimRunning
 *   (token CAS preparing→running), notify running;
 *
 *   success + static → markSchedulerClaimRunning + notify running directly.
 *
 * Auth: taskBearerAuth ({preparing}) — bearer = task id, single-purpose.
 * Idempotent: a repeat callback after the task already left `preparing` is
 * rejected by the auth middleware (401) — the endpoint never transitions a
 * running task twice.
 */

import { Hono } from "hono";
import { taskBearerAuth, getInternalTask } from "./task-bearer-auth.js";
import { logger } from "../../infra/logger.js";
import { AppError } from "../../infra/app-error.js";
import {
  getSchedulerClaim,
  getTaskById,
  markSchedulerClaimRunning,
  failSchedulerClaim,
  mergeTaskMetadata,
} from "../tasks/storage.js";
import { parsePrepareResult, isDynamicEnabled } from "../prepare/contract.js";
import { appendAndBroadcastCompletionEvent } from "../workers/scheduler-events.js";
import { loadConfig } from "../../infra/config.js";
import { getTaskSandbox, peekTaskSshPrivateKey } from "../sandboxes/index.js";
import { injectSandboxFiles, renderInjectionFiles } from "../workers/sandbox-inject.js";
import { getDocker, LABEL_TASK_TYPE, LABEL_TASK_ID, LABEL_SCHEDULER_CLAIM } from "../workers/docker-client.js";
import { notify } from "../notifications/index.js";

/** Gate watchdog cap (plan §4.1): 30 min, mirroring the retired prepare hard cap. */
export const GATE_WATCHDOG_MS = 30 * 60_000;
/** Sandbox allocation backoff answer for the submit script (matches SANDBOX_ALLOC_RETRY_MS). */
const RETRY_AFTER_S = 300;

export const prepareResultRouter = new Hono();
prepareResultRouter.use("*", taskBearerAuth);

prepareResultRouter.post("/", async (c) => {
  const task = getInternalTask(c);
  if (!task) return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "ERR_BAD_REQUEST" } }, 400);
  }
  const result = parsePrepareResult(body);
  if (!result) return c.json({ error: { code: "ERR_PREPARE_RESULT_INVALID" } }, 400);

  const taskId = task.id;
  const fresh = await getTaskById(taskId);
  if (!fresh || fresh.state !== "preparing") {
    // Repeat callback after the gate already transitioned the task — idempotent no-op.
    logger.info({ taskId, state: fresh?.state }, "prepare-result callback for non-preparing task; idempotent no-op");
    return c.json({ ok: true, idempotent: true });
  }
  const claim = getSchedulerClaim(fresh);
  if (!claim) return c.json({ error: { code: "ERR_NO_CLAIM" } }, 409);
  if (claim.mode !== "fresh") {
    // continue/resume never runs the gate; a callback there is bogus.
    logger.warn({ taskId, mode: claim.mode }, "prepare-result callback in non-fresh mode rejected");
    return c.json({ error: { code: "ERR_NOT_FRESH" } }, 409);
  }
  const token = claim.token;
  const dynamicEnabled = isDynamicEnabled(fresh);

  // Persist the three-field result + emit the same event stream the retired
  // prepare worker produced (web consumes unchanged).
  await mergeTaskMetadata(taskId, {
    prepare: {
      project_complete: result.project_complete,
      sandbox_type: result.sandbox_type,
      reason: result.reason,
      dynamic_enabled: dynamicEnabled,
      at: new Date().toISOString(),
    },
  }).catch((err) => logger.warn({ err, taskId }, "Failed to persist prepare result metadata"));

  appendAndBroadcastCompletionEvent(taskId, {
    type: "prepare_completed",
    source: "scan",
    seq: 0,
    ts: new Date().toISOString(),
    project_complete: result.project_complete,
    sandbox_type: result.sandbox_type,
    reason: result.reason,
  });

  const failBranch = async (reason: "source_incomplete" | "no_compatible_sandbox") => {
    if (reason === "source_incomplete") {
      await mergeTaskMetadata(taskId, { source_incomplete: true }).catch((err) =>
        logger.warn({ err, taskId }, "Failed to set source_incomplete flag"),
      );
    }
    const remediation = reason === "source_incomplete"
      ? "请补充完整项目源码后重新创建任务"
      : "关闭动态验证后重试，或联系管理员启用对应的沙箱类型";
    appendAndBroadcastCompletionEvent(taskId, {
      type: "prepare_failed",
      source: "scan",
      seq: 0,
      ts: new Date().toISOString(),
      reason,
      remediation,
    });
    await stopScanWorkerByToken(taskId, token);
    const failure = new AppError("ERR_PREPARE_FAILED", {
      message: reason === "source_incomplete"
        ? `源码不完整：功能代码缺失，无法建立完整的代码功能语义。审计目标应是自洽完整的功能项目（如 web 应用、CLI 应用、库）。${remediation}。`
        : `未找到兼容的沙箱类型（项目的主要运行方式没有可用的沙箱）。处理办法：${remediation}。`,
      details: { phase: "prepare", reason, remediation },
    });
    const failed = await failSchedulerClaim(
      taskId,
      token,
      JSON.stringify({ code: failure.code, message: failure.message, details: failure.details }),
    ).catch(() => false);
    if (failed) {
      notify({ type: "task_state", taskId, state: "failed" });
    }
  };

  if (!result.project_complete) {
    await failBranch("source_incomplete");
    return c.json({ ok: false, reason: result.reason, remediation: "请补充完整项目源码后重新创建任务" });
  }

  if (dynamicEnabled && result.sandbox_type === null) {
    await failBranch("no_compatible_sandbox");
    return c.json({ ok: false, reason: "no_compatible_sandbox", remediation: "关闭动态验证后重试，或联系管理员启用对应的沙箱类型" });
  }

  // ── Success: dynamic path — allocate sandbox, then inject into the RUNNING worker.
  if (dynamicEnabled && result.sandbox_type) {
    const config = loadConfig();
    let mapping: Awaited<ReturnType<typeof getTaskSandbox>>;
    try {
      const { ensureSandboxForTask } = await import("../sandboxes/lifecycle.js");
      mapping = (await ensureSandboxForTask(fresh, { profileId: result.sandbox_type })).mapping;
    } catch (err) {
      const { SandboxQuotaError } = await import("../sandboxes/lifecycle.js");
      const { SandboxPlaneCapacityError } = await import("../sandbox-plane/client.js");
      if (err instanceof SandboxQuotaError || err instanceof SandboxPlaneCapacityError) {
        const kind = err instanceof SandboxQuotaError ? "quota" : "capacity";
        logger.info({ taskId, kind }, "Sandbox allocation blocked at gate; answering retry_after");
        c.header("Retry-After", String(RETRY_AFTER_S));
        return c.json({ error: { code: "ERR_SANDBOX_ALLOC_RETRY", retry_after: RETRY_AFTER_S } }, 503);
      }
      throw err;
    }

    const privateKey = await peekTaskSshPrivateKey(taskId);
    if (!privateKey) throw new Error(`Gate: ssh key missing for task ${taskId} after allocation`);

    const container = await findRunningScanContainer(taskId, token);
    if (!container) throw new Error(`Gate: running scan worker not found for task ${taskId} (token ${token})`);
    const files = renderInjectionFiles(fresh, mapping, privateKey, {
      sshHostOverride: config.sandboxSshHostOverride ?? null,
      bastionSpec: config.sandboxSshBastion ?? null,
      bastionHostKey: config.sandboxSshBastionHostKey ?? null,
      bastionIdentityOpenSsh: config.sandboxSshBastionIdentity ?? null,
    });
    await injectSandboxFiles(container, files);
    await mergeTaskMetadata(taskId, {
      sandbox_alloc: { attempts: 0, next_attempt_at: null, sandbox_id: mapping.sandbox_id, profile_id: mapping.profile_id },
    }).catch((err) => logger.warn({ err, taskId }, "Failed to record sandbox_alloc metadata"));
    logger.info({ taskId, sandboxId: mapping.sandbox_id }, "Sandbox injected into running worker at gate");
  }

  const marked = await markSchedulerClaimRunning(taskId, token, new Date());
  if (!marked) {
    // Claim lost between auth and the CAS — reconciler owns the race.
    logger.warn({ taskId, token }, "Gate transition CAS failed (claim lost)");
    return c.json({ error: { code: "ERR_CLAIM_LOST" } }, 409);
  }
  notify({ type: "task_state", taskId, state: "running" });
  logger.info({ taskId, token, result }, "Onboard gate passed; task running");
  return c.json({ ok: true });
});

/** Find the claim-owned RUNNING scan container for the gate injection. */
async function findRunningScanContainer(taskId: string, token: string) {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({
      label: [
        `${LABEL_TASK_ID}=${taskId}`,
        `${LABEL_TASK_TYPE}=scan`,
        `${LABEL_SCHEDULER_CLAIM}=${token}`,
      ],
    }),
  });
  const running = containers.find((info) => info.State === "running" || info.State === "paused");
  return running ? docker.getContainer(running.Id) : null;
}

async function stopScanWorkerByToken(taskId: string, token: string): Promise<void> {
  const container = await findRunningScanContainer(taskId, token);
  if (container) {
    // docker stop = SIGTERM (worker exits 143); the 42/43 distinction lives
    // in the submit script only. The die handler in preparing state fails the
    // claim either way.
    await container.stop({ t: 10 }).catch((err) => logger.warn({ err, taskId }, "Gate: failed stopping worker"));
  }
}
