/**
 * Prepare worker (H5 §2): runs the minimal Prepare Flow (source-completeness
 * check + dynamic sandbox-type selection) inside the same worker image as a
 * scan, as a one-shot `vh-prepare-<task>` container, before the scan worker is
 * started.
 *
 * Owner discipline (②): the Scheduler spawns/stops this container while it
 * holds the task's scheduler claim, labelled with the claim token, so a lost
 * owner never touches a replacement's resources and reconciliation can adopt /
 * clean by exact token. The prepare phase has its own 30-minute platform hard
 * cap (H3 §3) — it does not consume the scan budget.
 *
 * The container runs `prepare-mode.sh` (MODE=prepare), which is fail-closed:
 * it only produces `prepare-result.json` in an empty output dir after the
 * embedded postflight validation. We then read that three-field result here
 * and branch per the frozen design matrix.
 */

import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type Dockerode from "dockerode";

import type { ServiceConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { AppError } from "../../infra/app-error.js";
import {
  createWorkerContainer,
  getDocker,
  LABEL_TASK_ID,
  LABEL_TASK_TYPE,
  LABEL_SCHEDULER_CLAIM,
} from "./docker-client.js";
import type { DbTask } from "../tasks/storage.js";
import { getCredentialById, getDefaultCredential } from "../settings/storage.js";

/** Platform hard cap for the prepare phase (H3 §3 / H5 §2): 30 minutes. */
export const PREPARE_HARD_CAP_MS = 30 * 60 * 1000;

/** Fixed in-container mount targets (must agree with the env passed below). */
const CONTAINER_SOURCE_ROOT = "/prepare-src";
const CONTAINER_OUTPUT_DIR = "/prepare-out";
// Outside CONTAINER_OUTPUT_DIR: prepare-mode.sh requires the output dir to
// start empty and postflight requires it to contain only prepare-result.json.
const CONTAINER_SANDBOX_TYPES_FILE = "/prepare-meta/sandbox-types.json";
/** In-container path of the flow's models.json (COPY flows/prepare → /opt/...). */
const CONTAINER_FLOW_MODELS_JSON = "/opt/vulnhunter/flows/prepare/models.json";

/** The three-field Prepare result contract (P1/P2 frozen). */
export interface PrepareResult {
  project_complete: boolean;
  sandbox_type: string | null;
  reason: "complete" | "partial_source" | "fragment_collection" | "no_compatible_sandbox";
}

function booleanMeta(meta: DbTask["source_meta"] | null | undefined, key: string): boolean {
  const v = meta?.[key];
  return v === true || v === "true";
}

/**
 * Whether the task's "动态验证/评估" (dynamic verification/assessment) switch is
 * on. Read from source_meta.dynamic_enabled; the task-creation batch (B3)
 * writes it there. Absent → false (static-only), preserving existing behavior.
 */
export function isDynamicEnabled(task: DbTask): boolean {
  return booleanMeta(task.source_meta, "dynamic_enabled");
}

export function getPrepareOutputDir(hostWorkDir: string): string {
  return join(hostWorkDir, ".prepare-output");
}

export function getPrepareSandboxTypesDir(hostWorkDir: string): string {
  // Mounted at /prepare-meta; the extension writes sandbox-types.json here.
  return join(hostWorkDir, ".prepare-meta");
}

export function getPrepareSandboxTypesFile(hostWorkDir: string): string {
  // Kept outside the output dir so prepare-mode.sh's "output dir must start
  // empty" invariant holds; postflight reads it for membership validation.
  return join(getPrepareSandboxTypesDir(hostWorkDir), "sandbox-types.json");
}

export interface SpawnPrepareWorkerOptions {
  task: DbTask;
  config: ServiceConfig;
  hostWorkDir: string;
  claimToken: string;
}

/**
 * Generate the prepare flow's models.json with the task's **real LLM credential**
 * written directly (fish 2026-08-04 decision: model-proxy removed; workers carry
 * user-owned keys — user bears the risk of scanning untrusted code).
 *
 * - baseUrl = credential base_url **as-is** (trailing-slash trim only, no path
 *   manipulation — pi SDK conventions: Anthropic SDK appends /v1/messages, so
 *   baseURL should NOT contain /v1; OpenAI SDK expects /v1 in baseURL).
 * - apiKey = decrypted real key (no task-id proxy).
 * - model id = the task's real model_id (forwarded verbatim by pi SDK).
 * - api type = mapped from proto_type.
 */
export async function resolvePrepareModel(task: DbTask): Promise<{ modelsJson: string; modelString: string }> {
  const cred = task.credential_id ? await getCredentialById(task.credential_id) : await getDefaultCredential();
  if (!cred || !cred.model_id) throw new AppError("ERR_MODEL_CREDENTIAL_UNAVAILABLE", { message: "Prepare 需要可用模型凭证，请在任务或 Settings 中配置模型" });
  const api = cred.proto_type.startsWith("anthropic") ? "anthropic-messages" : "openai-completions";
  const baseUrl = (cred.base_url ?? "").replace(/\/+$/, "");
  // fish 2026-08-05: completions endpoints default supportsDeveloperRole=false
  // (system understood everywhere; developer only matters on OpenAI o-series).
  const modelEntry: Record<string, unknown> = { id: cred.model_id };
  if (api === "openai-completions") modelEntry.compat = { supportsDeveloperRole: false };
  const models = {
    providers: {
      platform: {
        api,
        baseUrl,
        apiKey: cred.api_key,
        models: [modelEntry],
      },
    },
  };
  return { modelsJson: JSON.stringify(models, null, 2) + "\n", modelString: `platform/${cred.model_id}` };
}

/**
 * Create (but do not start) the prepare worker container. The source tree is
 * mounted read-only at PREPARE_SOURCE_ROOT; an empty dir is mounted at
 * PREPARE_OUTPUT_DIR. The deterministic name vh-prepare-<task> is the final
 * atomic guard; a name conflict fails closed rather than replacing.
 */
export async function createPrepareWorker(opts: SpawnPrepareWorkerOptions): Promise<Dockerode.Container> {
  const { task, config, hostWorkDir, claimToken } = opts;
  const sourceDir = join(hostWorkDir, "src");
  const outputDir = getPrepareOutputDir(hostWorkDir);
  const sandboxTypesDir = getPrepareSandboxTypesDir(hostWorkDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await rm(sandboxTypesDir, { recursive: true, force: true });
  await mkdir(sandboxTypesDir, { recursive: true });

  // Direct credential: models.json now carries the real LLM key + base_url
  // as-is (fish 2026-08-04: model-proxy removed).
  const { modelsJson, modelString } = await resolvePrepareModel(task);
  const modelsJsonHostPath = join(sandboxTypesDir, "models.json");
  await writeFile(modelsJsonHostPath, modelsJson, { mode: 0o644 });

  try {
    const old = getDocker().getContainer(`vh-prepare-${task.id}`);
    const info = await old.inspect();
    throw new Error(`Prepare worker name conflict for task ${task.id} (state=${info.State?.Status ?? "unknown"})`);
  } catch (err: any) {
    if (err?.statusCode !== 404) throw err;
  }

  return createWorkerContainer({
    taskId: task.id,
    taskType: "prepare",
    image: config.docker.workerImage,
    network: config.docker.network,
    cpuQuota: 200000,
    memoryBytes: 4 * 1024 * 1024 * 1024,
    labels: { [LABEL_SCHEDULER_CLAIM]: claimToken },
    // No hostWorkDir bind at /workspace — prepare-mode works off the explicit
    // mounts below.
    extraMounts: [
      { Type: "bind", Source: sourceDir, Target: CONTAINER_SOURCE_ROOT, ReadOnly: true },
      { Type: "bind", Source: outputDir, Target: CONTAINER_OUTPUT_DIR },
      { Type: "bind", Source: sandboxTypesDir, Target: "/prepare-meta" },
      { Type: "bind", Source: modelsJsonHostPath, Target: CONTAINER_FLOW_MODELS_JSON, ReadOnly: true },
    ],
    env: {
      MODE: "prepare",
      TASK_ID: task.id,
      SERVICE_URL: config.docker.workerServiceUrl,
      PREPARE_SOURCE_ROOT: CONTAINER_SOURCE_ROOT,
      PREPARE_OUTPUT_DIR: CONTAINER_OUTPUT_DIR,
      PREPARE_DYNAMIC_ENABLED: isDynamicEnabled(task) ? "true" : "false",
      PREPARE_SANDBOX_TYPES_FILE: CONTAINER_SANDBOX_TYPES_FILE,
      V_PREPARE_MODEL: modelString,
      // The service reads the root-written result as its own uid — tell the
      // worker who must own the outputs (self-aligning; prepare-mode.sh
      // chowns dir+file to this after postflight, modes stay 0700/0600).
      PREPARE_OUTPUT_OWNER_UID: String(process.getuid?.() ?? 1001),
    },
  });
}

/**
 * Spawn the prepare worker, wait for it to exit (bounded by the 30-minute
 * platform hard cap), then read + return the three-field result. On hard-cap
 * expiry the container is force-stopped and this throws; on a non-zero exit /
 * missing-or-invalid result it throws with the postflight reason.
 *
 * Returns the parsed PrepareResult on success.
 */
export async function runPrepareWorker(opts: SpawnPrepareWorkerOptions): Promise<PrepareResult> {
  const { task, hostWorkDir, claimToken } = opts;
  const container = await createPrepareWorker(opts);
  await container.start();
  logger.info({ taskId: task.id, claimToken }, "Prepare worker started");

  let timedOut = false;
  const cap = setTimeout(() => {
    timedOut = true;
    container.stop({ t: 5 }).catch((err) => logger.warn({ err, taskId: task.id }, "Failed to stop prepare worker on hard cap"));
  }, PREPARE_HARD_CAP_MS);
  cap.unref?.();

  let statusCode: number | undefined;
  try {
    const result = await container.wait();
    statusCode = result.StatusCode;
  } finally {
    clearTimeout(cap);
  }

  // Extract engine error tail BEFORE removing the container (spec §5).
  let errorDetail = "";
  if (!timedOut && statusCode !== 0) {
    try {
      const logStream = await container.logs({ stdout: true, stderr: true, tail: 50 });
      const lines = logStream.toString("utf8").split("\n");
      const hit = lines.find((l) => /error|Error|\b[45]\d\d\b/i.test(l));
      if (hit) errorDetail = hit.trim().slice(0, 300);
    } catch { /* ignore */ }
  }

  await container.remove({ force: true }).catch(() => undefined);

  if (timedOut) {
    throw new AppError("ERR_PREPARE_FAILED", {
      message: "Prepare 超时（超过 30 分钟平台上限）",
      details: { phase: "prepare", timeoutMs: PREPARE_HARD_CAP_MS },
    });
  }
  const outputDir = getPrepareOutputDir(hostWorkDir);
  if (statusCode !== 0) {
    throw new AppError("ERR_PREPARE_FAILED", {
      message: errorDetail
        ? `Prepare 失败（退出码 ${statusCode ?? "?"}）：${errorDetail}`
        : `Prepare 失败（退出码 ${statusCode ?? "?"}）`,
      details: {
        phase: "prepare",
        exitCode: statusCode,
        engineError: errorDetail || undefined,
        ...(errorDetail && /\b[45]\d\d\b/.test(errorDetail)
          ? { upstreamError: true }
          : {}),
      },
    });
  }
  const result = await readPrepareResult(outputDir);
  logger.info({ taskId: task.id, claimToken, result }, "Prepare worker completed");
  return result;
}

/**
 * Read and validate the three-field prepare-result.json. The in-container
 * postflight already enforces the durable schema (mode0600/regular/nlink1/
 * exact keys/enum reason); here we re-validate the minimal shape before
 * trusting it for branching — a malformed or missing file fails closed.
 */
export async function readPrepareResult(outputDir: string): Promise<PrepareResult> {
  let raw: string;
  try {
    raw = await readFile(join(outputDir, "prepare-result.json"), "utf8");
  } catch {
    throw new Error("Prepare 未产出结果文件 prepare-result.json");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Prepare 结果不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prepare 结果形状非法");
  }
  const v = value as Record<string, unknown>;
  if (typeof v.project_complete !== "boolean") throw new Error("Prepare 结果缺 project_complete");
  if (v.sandbox_type !== null && typeof v.sandbox_type !== "string") throw new Error("Prepare 结果 sandbox_type 非法");
  if (!["complete", "partial_source", "fragment_collection", "no_compatible_sandbox"].includes(String(v.reason))) {
    throw new Error("Prepare 结果 reason 非法");
  }
  return {
    project_complete: v.project_complete,
    sandbox_type: (v.sandbox_type as string | null) ?? null,
    reason: v.reason as PrepareResult["reason"],
  };
}

export async function hasRunningPrepareWorkerByClaim(taskId: string, token: string): Promise<boolean> {
  const containers = await getDocker().listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=prepare`, `${LABEL_SCHEDULER_CLAIM}=${token}`] }),
  });
  return containers.some((info) => info.State === "running" || info.State === "paused");
}

export async function stopPrepareWorkerByClaim(taskId: string, token: string): Promise<void> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${LABEL_TASK_ID}=${taskId}`, `${LABEL_TASK_TYPE}=prepare`, `${LABEL_SCHEDULER_CLAIM}=${token}`] }),
  });
  for (const info of containers) {
    try {
      const container = docker.getContainer(info.Id);
      if (info.State === "running" || info.State === "paused") await container.stop({ t: 10 }).catch(() => undefined);
      await container.remove({ force: true });
      logger.info({ taskId, token, containerId: info.Id }, "Claim-owned prepare worker stopped and removed");
    } catch (err) {
      logger.warn({ err, taskId, token, containerId: info.Id }, "Failed to stop claim-owned prepare worker");
    }
  }
}
