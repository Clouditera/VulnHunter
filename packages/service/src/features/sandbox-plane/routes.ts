/**
 * Internal read-only SandboxPlane proxy for the Prepare worker's
 * `sandbox-plane` pi extension (design v1.0 §5).
 *
 * Auth: the prepare worker container is launched with a bearer token equal
 * to its own task id (mirrors the existing CHAT_WORKER_TOKEN=sessionId
 * pattern in chat-session.ts). The token is validated here against the task
 * table and must reference a task currently in the `preparing` state — this
 * keeps the token single-purpose and time-boxed without a separate token
 * store. The extension itself, and the pi/bash sandbox it runs in, never see
 * the real SandboxPlane base URL or service token: those stay server-side in
 * ../../infra/config.ts and are only used inside client.ts.
 */
import { Hono } from "hono";
import { taskBearerAuth, getInternalTask } from "../internal/task-bearer-auth.js";
import { listSandboxPlaneProfiles, getSandboxPlaneProfile, SandboxPlaneUnavailableError } from "./client.js";
import { projectSandboxType, projectSandboxTypes } from "./project.js";
import { logger } from "../../infra/logger.js";
import { getSchedulerClaim, mergeTaskMetadata } from "../tasks/storage.js";
import { ensureSandboxForTask, SandboxQuotaError } from "../sandboxes/lifecycle.js";
import { SandboxPlaneCapacityError } from "./client.js";
import { peekTaskSshPrivateKey } from "../sandboxes/index.js";
import { injectSandboxFiles, renderInjectionFiles, renderSandboxMd } from "../workers/sandbox-inject.js";
import { getDocker, LABEL_TASK_ID, LABEL_TASK_TYPE, LABEL_SCHEDULER_CLAIM } from "../workers/docker-client.js";
import { loadConfig } from "../../infra/config.js";

export const sandboxPlaneInternalRouter = new Hono();

sandboxPlaneInternalRouter.use("*", taskBearerAuth);

// GET /internal/sandbox-plane/types — minimal projected list.
// Fails closed (empty list) on any SandboxPlane error instead of leaking
// error detail or falling back to a guessed default.
sandboxPlaneInternalRouter.get("/types", async (c) => {
  try {
    const raw = await listSandboxPlaneProfiles();
    return c.json({ types: projectSandboxTypes(raw) });
  } catch (err) {
    if (err instanceof SandboxPlaneUnavailableError) {
      logger.warn({ err: err.message }, "SandboxPlane list unavailable; failing closed");
      return c.json({ types: [] });
    }
    throw err;
  }
});

// GET /internal/sandbox-plane/types/:id — minimal projected single type.
// Same list/get projection as SandboxPlane's own GET /profiles/:id
// (v0.3.0 fixed this to share resolveProfileReadiness with the list path).
sandboxPlaneInternalRouter.get("/types/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const raw = await getSandboxPlaneProfile(id);
    if (!raw) return c.json({ type: null });
    return c.json({ type: projectSandboxType(raw) });
  } catch (err) {
    if (err instanceof SandboxPlaneUnavailableError) {
      logger.warn({ err: err.message, profileId: id }, "SandboxPlane get unavailable; failing closed");
      return c.json({ type: null });
    }
    throw err;
  }
});

// ── apply_sandbox (engine-native onboard gate, spec §4) ───────────────
// POST /internal/sandbox-plane/apply {profile_id}
// Auth: taskBearerAuth {preparing} + must be a fresh claim (else 409).
// Single attempt, no retries (fish 2026-08-19): failure answers a specific
// reason the agent copies into gate.yaml detail → END. Success allocates +
// injects the SSH files into the RUNNING worker and answers the alias-only
// sandbox_config text; the running→running CAS is NOT done here (the engine
// route-event perception owns the state transition).
sandboxPlaneInternalRouter.post("/apply", async (c) => {
  const task = getInternalTask(c);
  if (!task) return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);
  if (task.state !== "preparing") return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);

  const claim = getSchedulerClaim(task);
  if (!claim) return c.json({ error: { code: "ERR_NO_CLAIM" } }, 409);
  if (claim.mode !== "fresh") {
    logger.warn({ taskId: task.id, mode: claim.mode }, "apply_sandbox in non-fresh mode rejected");
    return c.json({ error: { code: "ERR_NOT_FRESH" } }, 409);
  }

  let body: { profile_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "ERR_BAD_REQUEST" } }, 400);
  }
  const profileId = typeof body.profile_id === "string" ? body.profile_id.trim() : "";
  if (!profileId) return c.json({ error: { code: "ERR_BAD_REQUEST", message: "profile_id required" } }, 400);

  const fail = (reason: string, message: string) => c.json({ ok: false, reason, message });

  // Re-validate against the live plane (list/get projections could be stale).
  let profile: Awaited<ReturnType<typeof getSandboxPlaneProfile>>;
  try {
    profile = await getSandboxPlaneProfile(profileId);
  } catch (err) {
    if (err instanceof SandboxPlaneUnavailableError) {
      return fail("plane_unavailable", "沙箱服务不可用");
    }
    throw err;
  }
  if (!profile || !projectSandboxType(profile).available) {
    return fail("type_unavailable", `沙箱类型不存在或当前不可用：${profileId}`);
  }

  try {
    const { mapping } = await ensureSandboxForTask(task, { profileId });
    const privateKey = await peekTaskSshPrivateKey(task.id);
    if (!privateKey) throw new Error(`apply_sandbox: ssh key missing for task ${task.id} after allocation`);

    const container = await findRunningScanContainer(task.id, claim.token);
    if (!container) throw new Error(`apply_sandbox: running scan worker not found for task ${task.id}`);

    const config = loadConfig();
    const files = renderInjectionFiles(mapping, privateKey, {
      sshHostOverride: config.sandboxSshHostOverride ?? null,
      bastionSpec: config.sandboxSshBastion ?? null,
      bastionHostKey: config.sandboxSshBastionHostKey ?? null,
      bastionIdentityOpenSsh: config.sandboxSshBastionIdentity ?? null,
    });
    await injectSandboxFiles(container, files);
    await mergeTaskMetadata(task.id, {
      sandbox_alloc: { attempts: 0, next_attempt_at: null, sandbox_id: mapping.sandbox_id, profile_id: mapping.profile_id },
    }).catch((err) => logger.warn({ err, taskId: task.id }, "Failed to record sandbox_alloc metadata"));

    const capabilities = ((task.metadata as Record<string, unknown> | undefined)?.prepare as
      | { sandbox_capabilities?: string[] }
      | undefined)?.sandbox_capabilities ?? [];
    logger.info({ taskId: task.id, sandboxId: mapping.sandbox_id }, "Sandbox allocated + injected at gate apply");
    // Alias-only description — no host/port/key material (spec §5).
    return c.json({ ok: true, sandbox_config: renderSandboxMd(capabilities) });
  } catch (err) {
    if (err instanceof SandboxQuotaError) {
      return fail("quota", "沙箱配额不足（本实例并发沙箱数已满）");
    }
    if (err instanceof SandboxPlaneCapacityError) {
      return fail("capacity", "沙箱服务容量不足");
    }
    if (err instanceof SandboxPlaneUnavailableError) {
      return fail("plane_unavailable", "沙箱服务不可用");
    }
    throw err;
  }
});

/** Find the claim-owned RUNNING scan container (moved from the retired gate route). */
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
