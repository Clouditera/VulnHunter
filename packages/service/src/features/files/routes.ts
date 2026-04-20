import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { uploadFile } from "../../infra/minio/client.js";
import { createTask } from "../tasks/storage.js";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../infra/config.js";

export const filesRouter = new Hono();

filesRouter.use("*", licenseGuard);
filesRouter.use("*", requireAuth);

// POST /api/tasks  — create from upload or git
// (Unified create endpoint, not in files/ conceptually, but wired here for Phase 2)
filesRouter.post("/tasks", async (c) => {
  const user = c.get("user");
  const config = loadConfig();

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

    const taskId = randomUUID();
    const minioKey = `code-packages/${taskId}.zip`;

    const arrayBuffer = await file.arrayBuffer();
    await uploadFile(config.minio.bucket, minioKey, Buffer.from(arrayBuffer), file.size);

    const task = await createTask({
      createdBy: user.userId,
      projectName: file.name.replace(/\.(zip|tar\.gz|tar\.bz2)$/, ""),
      sourceType: "upload",
      sourceMeta: { filename: file.name, minio_key: minioKey },
    });

    return c.json({ task }, 201);
  }

  // JSON body — git URL mode
  const body = await c.req.json<{
    git_url: string;
    git_branch?: string;
    project_name?: string;
    auto_skill_ids?: string[];
  }>();

  if (!body.git_url) {
    return c.json({ error: { code: "ERR_INTERNAL", detail: "git_url required" } }, 400);
  }

  const task = await createTask({
    createdBy: user.userId,
    projectName: body.project_name ?? new URL(body.git_url).pathname.split("/").pop() ?? "project",
    sourceType: "git",
    sourceMeta: { git_url: body.git_url, git_branch: body.git_branch ?? "main" },
    autoSkillIds: body.auto_skill_ids,
  });

  // TODO: trigger git clone + upload to MinIO in background

  return c.json({ task }, 201);
});
