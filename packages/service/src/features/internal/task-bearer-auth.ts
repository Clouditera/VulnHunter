/**
 * Shared task-id bearer auth for internal worker-facing proxy routes.
 *
 * The worker container is launched with a bearer token equal to its own task
 * id (mirrors CHAT_WORKER_TOKEN=sessionId in chat-session.ts). The token is
 * validated against the task table and must reference a task in an allowed
 * state — single-purpose and time-boxed without a separate token store. The
 * worker / pi / bash sandbox only ever sees its own task id, never any
 * upstream secret.
 *
 * Used by the sandbox-plane proxy (P2, {preparing}) and the model-proxy (P0,
 * {preparing, running} — scan workers run in `running`).
 */
import type { Context, Next } from "hono";
import { getTaskById, type DbTask } from "../tasks/storage.js";
import type { TaskState } from "@vulnhunter/shared";

export const TASK_BEARER_KEY = "internalTask";

/**
 * Build a Hono middleware: 401 unless a valid task-id bearer referencing a
 * task in one of `allowedStates` is present. On success the resolved task is
 * stored on the context under TASK_BEARER_KEY for downstream handlers (e.g.
 * the model-proxy needs it to resolve that task's credential).
 */
export function makeTaskBearerAuth(allowedStates: ReadonlySet<TaskState>) {
  return async function taskBearerAuth(c: Context, next: Next): Promise<Response | void> {
    // Primary: Authorization: Bearer <task-id>. Fallback: x-api-key — pi sends
    // the apiKey (our $TASK_ID template) in the x-api-key header when the
    // model's api is anthropic-messages, instead of an Authorization header.
    // Without this fallback, anthropic-credential tasks would always 401 here.
    // (The P2 sandbox-plane extension never sends x-api-key, so its behavior is
    // unchanged.)
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const taskId = match?.[1]?.trim() ?? (c.req.header("x-api-key")?.trim() || undefined);
    if (!taskId) return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);

    // A malformed (e.g. non-UUID) or unknown task id must fail closed with 401,
    // never propagate a DB error as a 500.
    const task = await getTaskById(taskId).catch(() => null);
    if (!task || !allowedStates.has(task.state)) {
      return c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);
    }
    c.set(TASK_BEARER_KEY, task);
    return next();
  };
}

/** P2 sandbox-plane proxy: prepare phase only. */
export const taskBearerAuth = makeTaskBearerAuth(new Set<TaskState>(["preparing"]));

/** Retrieve the task resolved by the middleware (undefined if not run). */
export function getInternalTask(c: Context): DbTask | undefined {
  return c.get(TASK_BEARER_KEY) as DbTask | undefined;
}
