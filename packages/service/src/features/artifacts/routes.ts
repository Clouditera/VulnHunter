/**
 * H4 dynamic artifact read API (read-only) + HALL-23 download endpoints.
 *   GET /:taskId/findings/:findingId/artifacts  — Finding three-card file lists
 *   GET /:taskId/exploits                       — EXP page data + four-state
 *   GET /:taskId/artifacts/file?path=<rel>      — single-file preview
 *   GET /:taskId/artifacts/file/download?path=<rel> — single-file raw download (HALL-23)
 *   GET /:taskId/artifacts/archive              — task-wide tar.gz (PR #70)
 *   GET /:taskId/findings/:findingId/artifacts/download — finding tar.gz (HALL-23)
 *   GET /:taskId/exploits/:exploitId/artifacts/download — exploit tar.gz (HALL-23)
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
  getArtifactFileDownload,
  getArtifactFilePreview,
  getExploitPageData,
  isValidExploitId,
  isValidFindingId,
  listArtifactTree,
  listArtifactTreeEntries,
  listExploitArtifacts,
  listFindingArtifacts,
  normalizeArtifactPath,
  streamArtifactArchive,
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

// GET /api/tasks/:taskId/artifacts/file/download?path=<rel> — single-file raw
// download (HALL-23). Same validation triple as the preview endpoint: any
// failure is the same 404, so existence never leaks. The MinIO stream is
// forwarded as-is (never buffered whole) with a basename-only RFC 5987
// Content-Disposition, so non-ASCII filenames work and header injection is
// impossible (control chars were already rejected by normalizeArtifactPath).
artifactsRouter.get("/:taskId/artifacts/file/download", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const relPath = normalizeArtifactPath(c.req.query("path"));
  if (!relPath) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  try {
    // Entries (not the path Set) so the listing size can seed Content-Length.
    const entries = await listArtifactTreeEntries(taskId, config.minio.bucket);
    const download = await getArtifactFileDownload(taskId, relPath, entries, config.minio.bucket);
    if (!download) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
    return new Response(download.stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${download.filenameStar}`,
        "Content-Length": String(download.size),
      },
    });
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_DOWNLOAD_FAILED", taskId, error_class: safeErrorClass(error) }, "Artifact download failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});

// GET /api/tasks/:taskId/findings/:findingId/artifacts/download — one-shot
// tar.gz of a single finding's whitelist subtree (HALL-23). Range = entries
// under findings/<findingId>/; empty range still yields a valid near-empty
// tar.gz (same semantics as the task-wide archive), never a 404.
artifactsRouter.get("/:taskId/findings/:findingId/artifacts/download", async (c) => {
  const { taskId, findingId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!isValidFindingId(findingId)) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const bucket = config.minio.bucket;
  let entries: Awaited<ReturnType<typeof listArtifactTreeEntries>>;
  try {
    const all = await listArtifactTreeEntries(taskId, bucket);
    entries = all.filter((e) => e.path.startsWith(`findings/${findingId}/`));
    const archive = await streamArtifactArchive(taskId, entries, bucket);
    if (archive === "ERR_ARCHIVE_TOO_LARGE") {
      return c.json({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } }, 413);
    }
    archive.headers.set("Content-Disposition", `attachment; filename="finding-${findingId}-artifacts.tar.gz"`);
    return archive;
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_ARCHIVE_FAILED", taskId, findingId, error_class: safeErrorClass(error) }, "Finding artifact archive build failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});

// GET /api/tasks/:taskId/exploits/:exploitId/artifacts/download — one-shot
// tar.gz of a single exploit chain's whitelist subtree (HALL-23). Same
// discipline as the finding archive above; range = exploits/<exploitId>/.
artifactsRouter.get("/:taskId/exploits/:exploitId/artifacts/download", async (c) => {
  const { taskId, exploitId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);
  if (!isValidExploitId(exploitId)) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const bucket = config.minio.bucket;
  try {
    const all = await listArtifactTreeEntries(taskId, bucket);
    const entries = all.filter((e) => e.path.startsWith(`exploits/${exploitId}/`));
    const archive = await streamArtifactArchive(taskId, entries, bucket);
    if (archive === "ERR_ARCHIVE_TOO_LARGE") {
      return c.json({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } }, 413);
    }
    archive.headers.set("Content-Disposition", `attachment; filename="exploit-${exploitId}-artifacts.tar.gz"`);
    return archive;
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_ARCHIVE_FAILED", taskId, exploitId, error_class: safeErrorClass(error) }, "Exploit artifact archive build failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});

// GET /api/tasks/:taskId/artifacts/archive — one-shot bulk collection of the
// findings/ + exploits/ whitelist trees as a streamed tar.gz. Keys come from
// the MinIO listing only (no user-controlled path), sharing the same whitelist
// discipline as the per-file preview endpoint. Tar assembly lives in the
// shared streamArtifactArchive helper (HALL-23 refactor; external behavior
// unchanged).
artifactsRouter.get("/:taskId/artifacts/archive", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const bucket = config.minio.bucket;

  let entries: Awaited<ReturnType<typeof listArtifactTreeEntries>>;
  try {
    entries = await listArtifactTreeEntries(taskId, bucket);
    const archive = await streamArtifactArchive(taskId, entries, bucket);
    if (archive === "ERR_ARCHIVE_TOO_LARGE") {
      return c.json({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } }, 413);
    }
    archive.headers.set("Content-Disposition", `attachment; filename="task-${taskId}-artifacts.tar.gz"`);
    return archive;
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_ARCHIVE_FAILED", taskId, error_class: safeErrorClass(error) }, "Artifact archive build failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});
