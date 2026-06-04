import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getCodeFile, getCodeTree } from "./code-viewer.js";
import { getTaskById } from "../tasks/storage.js";
import { loadConfig } from "../../infra/config.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getAccessibleTask } from "../tasks/access.js";

/** Resolve the actual MinIO zip key for a task (may differ from default pattern) */
async function resolveZipKey(taskId: string): Promise<string | undefined> {
  const task = await getTaskById(taskId);
  const meta = task?.source_meta as Record<string, string> | undefined;
  return meta?.minio_key || undefined;
}

export const workspaceRouter = new Hono();
workspaceRouter.use("*", licenseGuard);
workspaceRouter.use("*", requireAuth);

// GET /api/tasks/:taskId/workspace/tree
workspaceRouter.get("/:taskId/workspace/tree", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const config = loadConfig();

  const zipKey = await resolveZipKey(taskId);
  const tree = await getCodeTree(taskId, config.minio.bucket, zipKey);
  return c.json({ tree });
});

// GET /api/tasks/:taskId/workspace/file?path=<filepath>&line=<n>
workspaceRouter.get("/:taskId/workspace/file", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const filePath = c.req.query("path");
  const line = c.req.query("line") ? Number(c.req.query("line")) : undefined;
  const config = loadConfig();

  if (!filePath) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "path required" } }, 400);
  }

  const zipKey = await resolveZipKey(taskId);
  const result = await getCodeFile(taskId, config.minio.bucket, filePath, zipKey);
  if (!result) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  // Add line context hint for frontend
  const response = {
    ...result,
    requested_line: line,
  };

  return c.json(response);
});
