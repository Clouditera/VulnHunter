import { getDefaultOrFirstAvailableCredential, getCredentialById } from "../settings/storage.js";
import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { AppError } from "../../infra/app-error.js";
import { uploadFile } from "../../infra/minio/client.js";
import { checkTaskLimit, createTask, updateTaskState, hasTaskNameConflict } from "../tasks/storage.js";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { loadConfig } from "../../infra/config.js";
import { cloneAndUpload } from "./git-clone.js";
import { GitRemoteError, listRemoteBranches, validateRemoteGitUrl } from "./git-remote.js";
import { assertValidTaskName } from "../tasks/task-name-guard.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import { detectSourceArchive, stripSourceArchiveExtension } from "../source-archives/detect.js";
import { inspectSourceArchive } from "../source-archives/extract.js";
import { SourceArchiveError, sourceArchiveErrorResponse } from "../source-archives/errors.js";
import { getSourceArchivePolicy } from "../source-archives/policy.js";
import { resolveScanDuration } from "../tasks/scan-duration.js";
import { resolveDynamicToggles } from "../tasks/dynamic-toggles.js";

export const filesRouter = new Hono();

/**
 * Extract optional VulnForge scan tuning fields and normalize them into
 * source_meta. Only defined, non-empty values are included so existing
 * tasks/UI that omit them stay unaffected. scan_timeout / max_items_per_recon
 * are coerced to positive integers; invalid values are dropped.
 */
/** Parse optional agent_max_parallel: omit → undefined (default 3 downstream); invalid → throw. */
export function parseAgentMaxParallel(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("agent_max_parallel must be a positive integer");
  }
  return n;
}

/** Allowed output_language values (BCP-47 tags exposed by the product UI). */
const ALLOWED_OUTPUT_LANGUAGES = new Set(["zh-CN", "en"]);

export function normalizeOutputLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Accept common aliases
  if (trimmed === "zh" || trimmed === "zh_CN" || trimmed === "zh-cn") return "zh-CN";
  if (trimmed === "en-US" || trimmed === "en_US" || trimmed === "english") return "en";
  if (ALLOWED_OUTPUT_LANGUAGES.has(trimmed)) return trimmed;
  throw new Error(`invalid output_language: ${trimmed}`);
}

export function scanMetaFromValues(
  auditFocus?: string | null,
  scanTimeout?: string | number | null,
  maxItemsPerRecon?: string | number | null,
  timeoutMode?: string | null,
  dynamicSwitches?: { enableDynamicVerify?: unknown; enableDynamicExploit?: unknown },
  engineInputs?: { outputLanguage?: unknown; vulnFocus?: unknown },
): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = {};
  const focus = typeof auditFocus === "string" ? auditFocus.trim() : "";
  if (focus) meta.audit_focus = focus;
  // H3 two-tier scan duration. resolveScanDuration enforces the custom range
  // and forces the fixed 72h ceiling for auto mode; legacy callers that omit
  // timeout_mode are treated as custom. Only set when the caller supplied a
  // timeout or mode, so existing tasks/UI that omit them stay unaffected.
  if (timeoutMode !== undefined && timeoutMode !== null && timeoutMode !== "") {
    const resolved = resolveScanDuration(timeoutMode, scanTimeout);
    meta.scan_timeout = resolved.scan_timeout;
    meta.timeout_mode = resolved.timeout_mode;
  } else {
    const timeout = toPositiveInt(scanTimeout);
    if (timeout !== undefined) meta.scan_timeout = timeout;
  }
  const items = toPositiveInt(maxItemsPerRecon);
  if (items !== undefined) meta.max_items_per_recon = items;

  // Dynamic capability switches (B3 single mapping, shared by form + chat).
  Object.assign(meta, resolveDynamicToggles(dynamicSwitches ?? {}));

  // Engine inputs (fish 2026-08-09): output_language + vuln_focus.
  // Empty/absent → engine defaults (zh-CN / "关注可造成实际安全影响的漏洞。").
  const lang = normalizeOutputLanguage(engineInputs?.outputLanguage);
  if (lang) meta.output_language = lang;
  const vulnFocus = typeof engineInputs?.vulnFocus === "string" ? engineInputs.vulnFocus.trim() : "";
  if (vulnFocus) meta.vuln_focus = vulnFocus;

  return meta;
}

function scanMetaFromForm(formData: FormData): Record<string, string | number | boolean> {
  return scanMetaFromValues(
    formData.get("audit_focus") as string | null,
    formData.get("scan_timeout") as string | null,
    formData.get("max_items_per_recon") as string | null,
    formData.get("timeout_mode") as string | null,
    {
      enableDynamicVerify: formData.get("enable_dynamic_verify"),
      enableDynamicExploit: formData.get("enable_dynamic_exploit"),
    },
    {
      outputLanguage: formData.get("output_language"),
      vulnFocus: formData.get("vuln_focus"),
    },
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
    throw new AppError("ERR_GIT_REMOTE_UNREACHABLE");
  }
});

// POST /api/tasks  — create from upload or git
// (Unified create endpoint, not in files/ conceptually, but wired here for Phase 2)

async function resolveCreateCredentialId(
  ctx: ReturnType<typeof queryContextFromUser>,
  credentialId?: string | null,
): Promise<{ ok: true; credentialId: string } | { ok: false; status: 400; body: unknown }> {
  if (credentialId) {
    try {
      const cred = await getCredentialById(ctx, credentialId);
      if (!cred) {
        return {
          ok: false,
          status: 400,
          body: { error: { code: "ERR_NO_LLM_CREDENTIAL", detail: "选择的模型凭证不可用，请先在设置中配置模型凭证" } },
        };
      }
      return { ok: true, credentialId: cred.id };
    } catch {
      return {
        ok: false,
        status: 400,
        body: { error: { code: "ERR_NO_LLM_CREDENTIAL", detail: "模型凭证不可用，请先在设置中配置模型凭证" } },
      };
    }
  }
  try {
    const cred = await getDefaultOrFirstAvailableCredential(ctx);
    if (!cred) {
      return {
        ok: false,
        status: 400,
        body: { error: { code: "ERR_NO_LLM_CREDENTIAL", detail: "请先在设置中配置模型凭证后再创建任务" } },
      };
    }
    return { ok: true, credentialId: cred.id };
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: { code: "ERR_NO_LLM_CREDENTIAL", detail: "请先在设置中配置模型凭证后再创建任务" } },
    };
  }
}

filesRouter.post("/tasks", async (c) => {
  const user = c.get("user");
  const ctx = queryContextFromUser(user);
  const config = loadConfig();
  const limit = await checkTaskLimit(ctx);
  if (!limit.allowed) {
    throw new AppError("ERR_TASK_LIMIT_EXCEEDED", { details: { used: limit.used, limit: limit.limit } });
  }

  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    // Upload mode
    const policy = await getSourceArchivePolicy();
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > policy.max_bytes + 1024 * 1024) {
      throw new AppError("ERR_SOURCE_ARCHIVE_TOO_LARGE", { details: { limit_mb: policy.max_mb } });
    }

    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) throw new AppError("ERR_VALIDATION");

    if (file.size > policy.max_bytes) {
      throw new AppError("ERR_SOURCE_ARCHIVE_TOO_LARGE", { details: { limit_mb: policy.max_mb } });
    }

    const detected = detectSourceArchive(file.name);
    if (!detected) {
      throw new AppError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", { details: { extensions: policy.extensions } });
    }

    const credentialId = (formData.get("credential_id") as string | null) || undefined;
    const displayName = (formData.get("display_name") as string | null) || undefined;
    // Server-side task-name rule (task-8cb27359) — shared with the UI.
    assertValidTaskName(displayName);
    let agentMaxParallel: number | undefined;
    try {
      agentMaxParallel = parseAgentMaxParallel(formData.get("agent_max_parallel"));
    } catch (err) {
      throw new AppError("ERR_VALIDATION", { details: { reason: err instanceof Error ? err.message : String(err) } });
    }
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

    let scanMeta: Record<string, string | number | boolean>;
    try {
      scanMeta = scanMetaFromForm(formData);
    } catch (err) {
      throw new AppError("ERR_INVALID_SCAN_OPTIONS", { details: { reason: err instanceof Error ? err.message : String(err) } });
    }

    if (scanMeta.dynamic_enabled || scanMeta.enable_poc || scanMeta.enable_exp || scanMeta.enable_chain) {
      const { isSandboxPlaneConfigured } = await import("../sandbox-plane/client.js");
      if (!isSandboxPlaneConfigured()) {
        return c.json({
          error: {
            code: "ERR_SANDBOX_NOT_CONFIGURED",
            message: "沙箱服务未部署，无法开启动态验证",
          },
        }, 400);
      }
    }

    const credRes = await resolveCreateCredentialId(ctx, credentialId);
    if (!credRes.ok) return c.json(credRes.body, credRes.status as 400);

    const projectName = stripSourceArchiveExtension(file.name);
    const conflictName = (displayName?.trim() || projectName).trim();
    if (await hasTaskNameConflict(ctx, conflictName)) {
      return c.json({
        error: {
          code: "ERR_TASK_NAME_CONFLICT",
          message: "已存在同名任务，请修改名称",
        },
      }, 409);
    }

    const task = await createTask({
      tenantId: ctx.tenantId,
      createdBy: user.userId,
      projectName,
      displayName,
      sourceType: "upload",
      sourceMeta: { filename: file.name, minio_key: minioKey, size_bytes: file.size, archive_format: detected.format, ...scanMeta },
      credentialId: credRes.credentialId,
      agentMaxParallel,
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
    timeout_mode?: string;
    max_items_per_recon?: string | number;
    enable_dynamic_verify?: boolean;
    enable_dynamic_exploit?: boolean;
    agent_max_parallel?: number | string;
    output_language?: string;
    vuln_focus?: string;
  }>();

  if (!body.git_url) {
    throw new AppError("ERR_VALIDATION");
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

  let gitScanMeta: Record<string, string | number | boolean>;
  try {
    gitScanMeta = scanMetaFromValues(body.audit_focus, body.scan_timeout, body.max_items_per_recon, body.timeout_mode, {
      enableDynamicVerify: body.enable_dynamic_verify,
      enableDynamicExploit: body.enable_dynamic_exploit,
    }, {
      outputLanguage: body.output_language,
      vulnFocus: body.vuln_focus,
    });
  } catch (err) {
    throw new AppError("ERR_INVALID_SCAN_OPTIONS", { details: { reason: err instanceof Error ? err.message : String(err) } });
  }

  if (gitScanMeta.dynamic_enabled || gitScanMeta.enable_poc || gitScanMeta.enable_exp || gitScanMeta.enable_chain) {
    const { isSandboxPlaneConfigured } = await import("../sandbox-plane/client.js");
    if (!isSandboxPlaneConfigured()) {
      return c.json({
        error: {
          code: "ERR_SANDBOX_NOT_CONFIGURED",
          message: "沙箱服务未部署，无法开启动态验证",
        },
      }, 400);
    }
  }

  let agentMaxParallel: number | undefined;
  try {
    agentMaxParallel = parseAgentMaxParallel(body.agent_max_parallel);
  } catch (err) {
    throw new AppError("ERR_VALIDATION", { details: { reason: err instanceof Error ? err.message : String(err) } });
  }

  const credRes = await resolveCreateCredentialId(ctx, body.credential_id);
  if (!credRes.ok) return c.json(credRes.body, credRes.status as 400);

  const projectName = body.project_name ?? new URL(safeGitUrl).pathname.split("/").pop() ?? "project";
  // Server-side task-name rule (task-8cb27359) — shared with the UI.
  assertValidTaskName(body.display_name);
  const conflictName = (body.display_name?.trim() || projectName).trim();
  if (await hasTaskNameConflict(ctx, conflictName)) {
    return c.json({
      error: {
        code: "ERR_TASK_NAME_CONFLICT",
        message: "已存在同名任务，请修改名称",
      },
    }, 409);
  }

  const task = await createTask({
    tenantId: ctx.tenantId,
    createdBy: user.userId,
    projectName,
    displayName: body.display_name,
    sourceType: "git",
    sourceMeta: {
      git_url: safeGitUrl,
      ...(requestedBranch ? { git_branch: requestedBranch } : {}),
      ...gitScanMeta,
    },
    autoSkillIds: body.auto_skill_ids,
    credentialId: credRes.credentialId,
    agentMaxParallel,
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
