import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { uploadFile } from "../../infra/minio/client.js";
import { checkTaskLimit, createTask } from "../tasks/storage.js";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../infra/config.js";
import { cloneAndUpload } from "./git-clone.js";
import { queryContextFromUser } from "../../infra/query-context.js";

export const filesRouter = new Hono();

filesRouter.use("*", licenseGuard);
filesRouter.use("*", requireAuth);

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
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: { code: "ERR_INTERNAL", detail: "file required" } }, 400);

    const maxBytes = 500 * 1024 * 1024;
    if (file.size > maxBytes) {
      return c.json({ error: { code: "ERR_TASK_UPLOAD_TOO_LARGE" } }, 413);
    }

    const credentialId = (formData.get("credential_id") as string | null) || undefined;
    const displayName = (formData.get("display_name") as string | null) || undefined;
    const taskId = randomUUID();
    const minioKey = `code-packages/${taskId}.zip`;

    const arrayBuffer = await file.arrayBuffer();
    await uploadFile(config.minio.bucket, minioKey, Buffer.from(arrayBuffer), file.size);

    const task = await createTask({
      tenantId: ctx.tenantId,
      createdBy: user.userId,
      projectName: file.name.replace(/\.(zip|tar\.gz|tar\.bz2)$/, ""),
      displayName,
      sourceType: "upload",
      sourceMeta: { filename: file.name, minio_key: minioKey, size_bytes: file.size },
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
  }>();

  if (!body.git_url) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "git_url required" } }, 400);
  }

  const task = await createTask({
    tenantId: ctx.tenantId,
    createdBy: user.userId,
    projectName: body.project_name ?? new URL(body.git_url).pathname.split("/").pop() ?? "project",
    displayName: body.display_name,
    sourceType: "git",
    sourceMeta: { git_url: body.git_url, git_branch: body.git_branch ?? "main" },
    autoSkillIds: body.auto_skill_ids,
    credentialId: body.credential_id,
  });

  // Trigger async git clone (don't block response)
  const cfg = loadConfig();
  cloneAndUpload(
    task.id,
    body.git_url,
    body.git_branch ?? "main",
    cfg.minio.bucket,
  ).catch((err) => console.error("Background git clone error:", err));

  return c.json({ task }, 201);
});
