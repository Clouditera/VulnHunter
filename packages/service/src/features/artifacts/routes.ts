/**
 * H4 dynamic artifact read API (read-only). Three endpoints:
 *   GET /:taskId/findings/:findingId/artifacts  — Finding three-card file lists
 *   GET /:taskId/exploits                       — EXP page data + four-state
 *   GET /:taskId/artifacts/file?path=<rel>      — single-file preview
 * Guards identical to the findings router (license + auth + task visibility).
 */

import { Hono } from "hono";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { getMinio } from "../../infra/minio/client.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { getAccessibleTask } from "../tasks/access.js";
import {
  getArtifactFilePreview,
  getExploitPageData,
  isValidExploitId,
  isValidFindingId,
  listArtifactTree,
  listArtifactTreeEntries,
  listExploitArtifacts,
  listFindingArtifacts,
  normalizeArtifactPath,
} from "./artifacts.js";

/** One-shot archive size ceiling: refuse to assemble beyond this (pre-download). */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

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

// GET /api/tasks/:taskId/artifacts/archive — one-shot bulk collection of the
// findings/ + exploits/ whitelist trees as a streamed tar.gz. Keys come from
// the MinIO listing only (no user-controlled path), sharing the same whitelist
// discipline as the per-file preview endpoint.
artifactsRouter.get("/:taskId/artifacts/archive", async (c) => {
  const { taskId } = c.req.param();
  const task = await getAccessibleTask(queryContextFromUser(c.get("user")), taskId);
  if (!task) return c.json({ error: { code: "ERR_TASK_NOT_FOUND" } }, 404);

  const config = loadConfig();
  const bucket = config.minio.bucket;

  let entries: Awaited<ReturnType<typeof listArtifactTreeEntries>>;
  try {
    entries = await listArtifactTreeEntries(taskId, bucket);
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_ARCHIVE_FAILED", taskId, error_class: safeErrorClass(error) }, "Artifact archive listing failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_ARCHIVE_BYTES) {
    return c.json({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } }, 413);
  }

  // Materialize the tree under a private temp dir (relative structure kept),
  // then stream a tar.gz off it. Cleanup runs on stream close — covering both
  // normal completion and a client that disconnects mid-download.
  const tmpRoot = await mkdtemp(join(tmpdir(), `task-artifacts-${taskId}-`));
  const cleanup = () => { rm(tmpRoot, { recursive: true, force: true }).catch(() => { /* best effort */ }); };
  try {
    const minio = getMinio();
    for (const entry of entries) {
      const dest = join(tmpRoot, entry.path);
      await mkdir(dirname(dest), { recursive: true });
      const objStream = await minio.getObject(bucket, `scan-outputs/${taskId}/${entry.path}`);
      await pipeline(objStream, createWriteStream(dest));
    }

    // Empty tree still yields a valid (near-empty) tar.gz — "no artifacts",
    // never a 404. tar.c rejects an empty path list, so pack the temp root.
    const paths = entries.length > 0 ? entries.map((entry) => entry.path) : ["."];
    const archive = tar.c({ gzip: true, cwd: tmpRoot }, paths);
    archive.on("close", cleanup);
    archive.on("error", cleanup);

    return new Response(archive as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="task-${taskId}-artifacts.tar.gz"`,
      },
    });
  } catch (error) {
    cleanup();
    logger.warn({ code: "WARN_ARTIFACT_ARCHIVE_FAILED", taskId, error_class: safeErrorClass(error) }, "Artifact archive build failed");
    return c.json({ error: { code: "ERR_INTERNAL" } }, 500);
  }
});
