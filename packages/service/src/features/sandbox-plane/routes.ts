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
import { taskBearerAuth } from "../internal/task-bearer-auth.js";
import { listSandboxPlaneProfiles, getSandboxPlaneProfile, SandboxPlaneUnavailableError } from "./client.js";
import { projectSandboxType, projectSandboxTypes } from "./project.js";
import { logger } from "../../infra/logger.js";

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
