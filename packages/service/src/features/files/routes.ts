import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { uploadFile } from "../../infra/minio/client.js";
import { checkTaskLimit, createTask, updateTaskState } from "../tasks/storage.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { loadConfig } from "../../infra/config.js";
import { cloneAndUpload } from "./git-clone.js";
import { GitRemoteError, listRemoteBranches, validateRemoteGitUrl } from "./git-remote.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { detectSourceArchive, stripSourceArchiveExtension } from "../source-archives/detect.js";
import { inspectSourceArchive } from "../source-archives/extract.js";
import { SourceArchiveError, sourceArchiveErrorResponse } from "../source-archives/errors.js";
import { getSourceArchivePolicy } from "../source-archives/policy.js";

export const filesRouter = new Hono();

/**
 * Extract optional VulnForge scan tuning fields and normalize them into
 * source_meta. Only defined, non-empty values are included so existing
 * tasks/UI that omit them stay unaffected. scan_timeout / max_items_per_recon
 * are coerced to positive integers; invalid values are dropped.
 */
export function scanMetaFromValues(
  auditFocus?: string | null,
  scanTimeout?: string | number | null,
  maxItemsPerRecon?: string | number | null,
): Record<string, string | number> {
  const meta: Record<string, string | number> = {};
  const focus = typeof auditFocus === "string" ? auditFocus.trim() : "";
  if (focus) meta.audit_focus = focus;
  const timeout = toPositiveInt(scanTimeout);
  if (timeout !== undefined) meta.scan_timeout = timeout;
  const items = toPositiveInt(maxItemsPerRecon);
  if (items !== undefined) meta.max_items_per_recon = items;
  return meta;
}

function scanMetaFromForm(formData: FormData): Record<string, string | number> {
  return scanMetaFromValues(
    formData.get("audit_focus") as string | null,
    formData.get("scan_timeout") as string | null,
    formData.get("max_items_per_recon") as string | null,
  );
}

export function toPositiveInt(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.trunc(n);
}

filesRouter.use("*", async (c, next) => {
  if (c.req.path === "/api/system/activate") return next();
  return licenseGuard(c, next);
});
filesRouter.use("*", async (c, next) => {
  if (c.req.path === "/api/system/activate") return next();
  return requireAuth(c, next);
});

// GET /api/git/branches — lightweight remote branch discovery (no clone)
filesRouter.get("/git/branches", async (c) => {
  const gitUrl = c.req.query("url") ?? "";
  try {
    const result = await listRemoteBranches(gitUrl);
    return c.json(result);
  } catch (err) {
    if (err instanceof GitRemoteError) {
      return c.json({ error: { code: err.code, detail: err.message } }, err.status);
    }
    return c.json({ error: { code: "ERR_GIT_REMOTE_UNREACHABLE", detail: "无法访问该源码仓库，请检查仓库地址和分支是否正确，或改用上传 ZIP 压缩包的方式创建任务。" } }, 502);
  }
});

// POST /api/tasks  — create from upload or git
// (Unified create endpoint, not in files/ conceptually, but wired here for Phase 2)
filesRouter.post("/tasks", async (c) => {
  const user = c.get("user");
  const ctx = queryContextFromUser(user);
  const config = loadConfig();
  const limit = await checkTaskLimit(ctx);
  if (!limit.allowed) {
    return c.json({ error: { code: "ERR_TASK_LIMIT_EXCEEDED", message: `Task limit reached (${limit.used}/${limit.limit})`, used: limit.used, limit: limit.limit } }, 403);
  }

  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    // Upload mode
    const policy = await getSourceArchivePolicy();
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > policy.max_bytes + 1024 * 1024) {
      return c.json({ error: { code: "ERR_SOURCE_ARCHIVE_TOO_LARGE", message: `Source archive exceeds ${policy.max_mb} MB`, limit_mb: policy.max_mb } }, 413);
    }

    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: { code: "ERR_INTERNAL", detail: "file required" } }, 400);

    if (file.size > policy.max_bytes) {
      return c.json({ error: { code: "ERR_SOURCE_ARCHIVE_TOO_LARGE", message: `Source archive exceeds ${policy.max_mb} MB`, limit_mb: policy.max_mb } }, 413);
    }

    const detected = detectSourceArchive(file.name);
    if (!detected) {
      return c.json({ error: { code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", message: `Unsupported source archive format. Supported: ${policy.extensions.join(", ")}`, extensions: policy.extensions } }, 400);
    }

    const credentialId = (formData.get("credential_id") as string | null) || undefined;
    const displayName = (formData.get("display_name") as string | null) || undefined;
    const taskId = randomUUID();
    const minioKey = `code-packages/${taskId}${detected.storageExtension}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const tmpPath = join(tmpdir(), `va-source-archive-${taskId}${detected.storageExtension}`);
    try {
      await writeFile(tmpPath, buffer);
      await inspectSourceArchive(tmpPath, file.name, policy);
    } catch (err) {
      if (err instanceof SourceArchiveError) return c.json(sourceArchiveErrorResponse(err), err.status as 400 | 413);
      return c.json(sourceArchiveErrorResponse(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read source archive")), 400);
    } finally {
      await unlink(tmpPath).catch(() => {});
    }

    await uploadFile(config.minio.bucket, minioKey, buffer, file.size);

    const task = await createTask({
      tenantId: ctx.tenantId,
      createdBy: user.userId,
      projectName: stripSourceArchiveExtension(file.name),
      displayName,
      sourceType: "upload",
      sourceMeta: { filename: file.name, minio_key: minioKey, size_bytes: file.size, archive_format: detected.format, ...scanMetaFromForm(formData) },
      credentialId,
    });

    return c.json({ task }, 201);
  }

  // JSON body — git URL mode
  const body = await c.req.json<{
    git_url: string;
    git_branch?: string;
    project_name?: string;
    auto_skill_ids?: string[];
    credential_id?: string;
    display_name?: string;
    audit_focus?: string;
    scan_timeout?: string | number;
    max_items_per_recon?: string | number;
  }>();

  if (!body.git_url) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "git_url required" } }, 400);
  }

  let safeGitUrl: string;
  try {
    safeGitUrl = validateRemoteGitUrl(body.git_url);
  } catch (err) {
    if (err instanceof GitRemoteError) {
      return c.json({ error: { code: err.code, detail: err.message } }, err.status);
    }
    throw err;
  }
  const requestedBranch = body.git_branch?.trim() || undefined;

  const task = await createTask({
    tenantId: ctx.tenantId,
    createdBy: user.userId,
    projectName: body.project_name ?? new URL(safeGitUrl).pathname.split("/").pop() ?? "project",
    displayName: body.display_name,
    sourceType: "git",
    sourceMeta: {
      git_url: safeGitUrl,
      ...(requestedBranch ? { git_branch: requestedBranch } : {}),
      ...scanMetaFromValues(body.audit_focus, body.scan_timeout, body.max_items_per_recon),
    },
    autoSkillIds: body.auto_skill_ids,
    credentialId: body.credential_id,
  });

  // Git tasks start in `preparing` (cloning/zipping/uploading) — distinct from
  // `queued` (code ready, waiting for a worker). cloneAndUpload flips it to
  // queued on success, failed on error.
  await updateTaskState(task.id, "preparing");

  // Trigger async git clone (don't block response)
  const cfg = loadConfig();
  cloneAndUpload(
    task.id,
    safeGitUrl,
    requestedBranch,
    cfg.minio.bucket,
  ).catch((err) => console.error("Background git clone error:", err));

  return c.json({ task }, 201);
});
