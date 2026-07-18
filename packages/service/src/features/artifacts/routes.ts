/**
 * H4 dynamic artifact read API (read-only). Three endpoints:
 *   GET /:taskId/findings/:findingId/artifacts  — Finding three-card file lists
 *   GET /:taskId/exploits                       — EXP page data + four-state
 *   GET /:taskId/artifacts/file?path=<rel>      — single-file preview
 * Guards identical to the findings router (license + auth + task visibility).
 */

import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getAccessibleTask } from "../tasks/access.js";
import {
  getArtifactFilePreview,
  getExploitPageData,
  isValidExploitId,
  isValidFindingId,
  listArtifactTree,
  listExploitArtifacts,
  listFindingArtifacts,
  normalizeArtifactPath,
} from "./artifacts.js";

export const artifactsRouter = new Hono();
artifactsRouter.use("*", licenseGuard);
artifactsRouter.use("*", requireAuth);

function safeErrorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

// GET /api/tasks/:taskId/findings/:findingId/artifacts
artifactsRouter.get("/:taskId/findings/:findingId/artifacts", async (c) => {
  const { taskId, findingId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!isValidFindingId(findingId)) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  try {
    const groups = await listFindingArtifacts(taskId, findingId, config.minio.bucket);
    return c.json(groups);
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_LIST_FAILED", taskId, findingId, error_class: safeErrorClass(error) }, "Finding artifact listing failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});

// GET /api/tasks/:taskId/exploits/:exploitId/artifacts — EXP page companion
// file list. Same whitelist/404 discipline as the finding-artifacts route.
artifactsRouter.get("/:taskId/exploits/:exploitId/artifacts", async (c) => {
  const { taskId, exploitId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!isValidExploitId(exploitId)) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  try {
    const data = await listExploitArtifacts(taskId, exploitId, config.minio.bucket);
    return c.json(data);
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_LIST_FAILED", taskId, exploitId, error_class: safeErrorClass(error) }, "Exploit artifact listing failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});

// GET /api/tasks/:taskId/exploits
artifactsRouter.get("/:taskId/exploits", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  try {
    const data = await getExploitPageData(task, config.minio.bucket);
    return c.json(data);
  } catch (error) {
    logger.warn({ code: "WARN_EXPLOITS_PAGE_FAILED", taskId, error_class: safeErrorClass(error) }, "EXP page data failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});

// GET /api/tasks/:taskId/artifacts/file?path=<rel>
artifactsRouter.get("/:taskId/artifacts/file", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  // Validation triple (H4 §2.③): whitelist root + normalization, then tree
  // membership — any failure is the same 404, so existence never leaks.
  const relPath = normalizeArtifactPath(c.req.query("path"));
  if (!relPath) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  try {
    const tree = await listArtifactTree(taskId, config.minio.bucket);
    const preview = await getArtifactFilePreview(taskId, relPath, tree, config.minio.bucket);
    if (!preview) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
    return c.json(preview);
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_PREVIEW_FAILED", taskId, error_class: safeErrorClass(error) }, "Artifact preview failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});
