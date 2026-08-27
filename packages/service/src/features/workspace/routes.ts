import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getCodeFile, getCodeTree, getCodeFileFromMinioKey, resolveSourceFilesKey, resolveLegacyDecompiledKey, resolveClassToJavaKey } from "./code-viewer.js";
import { loadConfig } from "../../infra/config.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getAccessibleTask } from "../tasks/access.js";
import { resolveArchiveIdentity } from "../source-archives/detect.js";

export const workspaceRouter = new Hono();
workspaceRouter.use("*", licenseGuard);
workspaceRouter.use("*", requireAuth);

// GET /api/tasks/:taskId/workspace/tree
workspaceRouter.get("/:taskId/workspace/tree", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  const config = loadConfig();

  const archive = resolveArchiveIdentity({ taskId, sourceMeta: task.source_meta });
  const tree = await getCodeTree(taskId, config.minio.bucket, archive.minioKey, archive.filename);
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

  const archive = resolveArchiveIdentity({ taskId, sourceMeta: task.source_meta });
  const bucket = config.minio.bucket;

  // HALL-25: .class requests consult the decompile manifest FIRST. A hit
  // returns the mapped .java plus `decompiled_from` / `resolved_path`
  // (both optional — old clients ignore them). Every miss keeps the exact
  // pre-existing behavior below (three-level fallback → binary view).
  if (filePath.endsWith(".class")) {
    const classHit = await resolveClassToJavaKey(bucket, taskId, filePath);
    if (classHit) {
      const javaResult = await getCodeFileFromMinioKey(taskId, bucket, classHit.javaKey, classHit.javaPath);
      if (javaResult) {
        return c.json({
          ...javaResult,
          requested_line: line,
          decompiled_from: filePath,
          resolved_path: classHit.javaPath,
        });
      }
    }
  }

  // source-files three-level fallback (task-c069aab9):
  // a) direct key in the source-files tree
  // b) decompiled-root relative path (finding primary_file semantics)
  // c) legacy blob (+ legacy out/ decompiled location for old completed tasks)
  const sourceFilesKey = await resolveSourceFilesKey(bucket, taskId, filePath);
  if (sourceFilesKey) {
    const sfResult = await getCodeFileFromMinioKey(taskId, bucket, sourceFilesKey, filePath);
    if (sfResult) {
      return c.json({ ...sfResult, requested_line: line });
    }
  }
  // Legacy out/-era location: jarName layer required (architect review r1 —
  // direct concat never matched the real key shape).
  const legacyKey = await resolveLegacyDecompiledKey(bucket, taskId, filePath);
  if (legacyKey) {
    const legacyResult = await getCodeFileFromMinioKey(taskId, bucket, legacyKey, filePath);
    if (legacyResult) {
      return c.json({ ...legacyResult, requested_line: line });
    }
  }
  const result = await getCodeFile(taskId, config.minio.bucket, filePath, archive.minioKey, archive.filename);
  if (!result) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  // Add line context hint for frontend
  const response = {
    ...result,
    requested_line: line,
  };

  return c.json(response);
});
