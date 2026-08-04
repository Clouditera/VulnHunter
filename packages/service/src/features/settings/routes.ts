import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { AppError } from "../../infra/app-error.js";
import {
  getDefaultCredential,
  listCredentials,
  deleteCredential,
  setDefaultCredential,
  upsertCredential,
  getCredentialById,
} from "./storage.js";
import { logger } from "../../infra/logger.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { runPiDiagnostics, type DiagnosticEvent } from "./pi-diagnostics.js";
import { lookupModelMeta } from "./pi-model-catalog.js";
import { loadConfig } from "../../infra/config.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import * as reportStorage from "../reports/storage.js";
import { uploadFile, getMinio } from "../../infra/minio/client.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
const VALID_PROTO_TYPES = new Set(["openai-completions", "openai-responses", "anthropic", "openai"]);
function parseContextWindowTokens(value: unknown): number {
  if (value == null) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid context_window_tokens");
  const tokens = Math.trunc(value);
  if (tokens < 1000 || tokens > 10000000) throw new Error("invalid context_window_tokens");
  return tokens;
}

export const settingsRouter = new Hono();
settingsRouter.use("*", licenseGuard);
settingsRouter.use("*", requireAuth);

// GET /api/settings/credential — show active LLM credential (no api_key)
settingsRouter.get("/credential", async (c) => {
  try {
    const ctx = queryContextFromUser(c.get("user"));
    const cred = await getDefaultCredential(ctx);
    if (!cred) return c.json({ credential: null });
    const key = cred.api_key;
    const masked_key = key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : "••••••••";
    const { api_key: _ak, api_key_ciphertext: _c, api_key_iv: _i, api_key_tag: _t, ...safe } = cred as typeof cred & Record<string, unknown>;
    return c.json({ credential: { ...safe, masked_key, credential_health: "ok" } });
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      return c.json({ credential: { credential_health: "key_unavailable", masked_key: "key 未配置" } });
    }
    if (err instanceof CredentialDecryptError) {
      return c.json({ credential: { credential_health: "decrypt_failed", masked_key: "无法解密" } });
    }
    throw err;
  }
});

// GET /api/settings/credentials — list all credentials (no api_key)
settingsRouter.get("/credentials", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const creds = await listCredentials(ctx);
  return c.json({ credentials: creds });
});

async function handleDeleteCredential(c: any) {
  const ctx = queryContextFromUser(c.get("user"));
  const id = c.req.param("id");
  const ok = await deleteCredential(ctx, id);
  if (!ok) throw new AppError("ERR_NOT_FOUND");
  return c.json({ ok: true });
}

// DELETE /api/settings/credentials/:id — delete a credential
settingsRouter.delete("/credentials/:id", handleDeleteCredential);

// DELETE /api/settings/credential/:id — compatibility alias for singular credential route
settingsRouter.delete("/credential/:id", handleDeleteCredential);

// POST /api/settings/credentials/:id/default — set as default
settingsRouter.post("/credentials/:id/default", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const id = c.req.param("id");
  await setDefaultCredential(ctx, id);
  return c.json({ ok: true });
});

// PUT /api/settings/credential — save/update LLM credential
// Save gate: L1-L3 pi-native diagnostics must pass before persisting (fish 2026-08-04).
settingsRouter.put("/credential", async (c) => {
  const body = await c.req.json<{
    id?: string;
    provider: string;
    proto_type: string;
    base_url?: string;
    model_id: string;
    thinking_effort?: string;
    label?: string;
    api_key: string;
    is_default?: boolean;
    context_window_tokens?: number;
    owner_id?: string | null;
  }>();

  if (!body.provider || !body.proto_type || !body.model_id || !body.base_url) {
    return c.json(
      { error: { code: "ERR_BAD_REQUEST", detail: "provider, proto_type, base_url, model_id required" } },
      400,
    );
  }
  if (!VALID_PROTO_TYPES.has(body.proto_type)) {
    throw new AppError("ERR_VALIDATION", { details: { field: "proto_type" } });
  }

  let contextWindowTokens: number;
  try {
    contextWindowTokens = parseContextWindowTokens(body.context_window_tokens);
  } catch {
    throw new AppError("ERR_VALIDATION", { details: { field: "context_window_tokens" } });
  }

  const ctx = queryContextFromUser(c.get("user"));

  // ── Save gate: run L1-L3 before persisting (fish 2026-08-04) ──
  {
    const gateCred = {
      id: body.id ?? "gate",
      provider: body.provider,
      proto_type: body.proto_type,
      base_url: body.base_url!,
      model_id: body.model_id,
      thinking_effort: body.thinking_effort,
      api_key: body.api_key,
      context_window_tokens: contextWindowTokens,
      is_default: false,
      created_at: new Date(),
      updated_at: new Date(),
    } as any;
    const gateResult = await runPiDiagnostics(gateCred, () => {});
    if (!gateResult.ok) {
      return c.json(
        {
          error: {
            code: "ERR_CREDENTIAL_TEST_FAILED",
            message: "凭证测试未通过，未保存。",
            checks: gateResult.checks,
          },
        },
        422,
      );
    }
  }

  let id: string;
  try {
    id = await upsertCredential({
      id: body.id,
      provider: body.provider,
      protoType: body.proto_type,
      baseUrl: body.base_url,
      modelId: body.model_id,
      thinkingEffort: body.thinking_effort,
      label: body.label,
      apiKey: body.api_key ?? "",
      isDefault: body.is_default,
      contextWindowTokens,
      ownerId: ctx.role === "admin" ? (body.owner_id ?? null) : undefined,
      ctx,
    });
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      throw new AppError("ERR_CREDENTIAL_KEY_UNAVAILABLE");
    }
    throw err;
  }

  if (body.id && !id) throw new AppError("ERR_NOT_FOUND");

  // L4 auto deep verification after save: DISABLED 2026-08-04 (fish — the
  // deep-verified badge + auto check landed without his sign-off; only the
  // L1-L3 save gate stays, which he confirmed). runL4Check code is kept;
  // re-enable by restoring the trigger here.
  return c.json({ id });
});

// PATCH /api/settings/credential/:id — update metadata without re-entering API key
settingsRouter.patch("/credential/:id", async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{
    provider?: string;
    proto_type?: string;
    base_url?: string;
    model_id?: string;
    thinking_effort?: string;
    label?: string;
    context_window_tokens?: number;
    owner_id?: string | null;
  }>();

  if (body.proto_type !== undefined && !VALID_PROTO_TYPES.has(body.proto_type)) {
    throw new AppError("ERR_VALIDATION", { details: { field: "proto_type" } });
  }

  let contextWindowTokens: number | undefined;
  if (body.context_window_tokens !== undefined) {
    try {
      contextWindowTokens = parseContextWindowTokens(body.context_window_tokens);
    } catch {
      throw new AppError("ERR_VALIDATION", { details: { field: "context_window_tokens" } });
    }
  }

  const ctx = queryContextFromUser(c.get("user"));
  const { updateCredentialMeta } = await import("./storage.js");
  const ok = await updateCredentialMeta({
    id,
    provider: body.provider,
    protoType: body.proto_type,
    baseUrl: body.base_url,
    modelId: body.model_id,
    thinkingEffort: body.thinking_effort,
    label: body.label,
    contextWindowTokens,
    ownerId: ctx.role === "admin" ? body.owner_id : undefined,
    ctx,
  });

  if (!ok) throw new AppError("ERR_NOT_FOUND");
  return c.json({ ok: true });
});

// POST /api/settings/credential/diagnose-stream — SSE pi-native diagnostics (L1-L3)
settingsRouter.post("/credential/diagnose-stream", async (c) => {
  const body = await c.req.json<{
    credential_id?: string;
    proto_type?: string;
    base_url?: string;
    model_id?: string;
    api_key?: string;
    thinking_effort?: string;
  }>();

  let protoType = body.proto_type ?? "";
  let baseUrl = (body.base_url ?? "").replace(/\/+$/, "");
  let modelId = body.model_id ?? "";
  let apiKey = body.api_key ?? "";
  let thinkingEffort = body.thinking_effort;

  // Load saved credential if id provided
  if (body.credential_id) {
    const ctx = queryContextFromUser(c.get("user"));
    const saved = await getCredentialById(ctx, body.credential_id);
    if (!saved) throw new AppError("ERR_NOT_FOUND");
    protoType = protoType || saved.proto_type;
    baseUrl = baseUrl || (saved.base_url ?? "").replace(/\/+$/, "");
    modelId = modelId || saved.model_id;
    apiKey = apiKey || saved.api_key;
    thinkingEffort = thinkingEffort ?? saved.thinking_effort;
  }

  const cred = {
    id: body.credential_id ?? "diagnostic",
    provider: "diagnostic",
    proto_type: protoType,
    base_url: baseUrl,
    model_id: modelId,
    thinking_effort: thinkingEffort,
    api_key: apiKey,
    context_window_tokens: 128000,
    is_default: false,
    created_at: new Date(),
    updated_at: new Date(),
  } as any;

  return streamSSE(c, async (stream) => {
    const emit = (event: DiagnosticEvent) => {
      stream.writeSSE({ data: JSON.stringify(event) });
    };
    await runPiDiagnostics(cred, emit);
  });
});

// POST /api/settings/models — list models using provided or saved credential
settingsRouter.post("/models", async (c) => {
  const body = await c.req.json<{ base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }>().catch(() => ({} as { base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }));

  // Use form values if provided, otherwise fall back to saved/default credential
  let baseUrl: string;
  let apiKey: string;
  let protoType: string;

  if (body.credential_id) {
    // Editing existing credential: use saved api_key, override base_url if provided
    const { getCredentialById } = await import("./storage.js");
    try {
      const ctx = queryContextFromUser(c.get("user"));
      const saved = await getCredentialById(ctx, body.credential_id);
      if (!saved) return c.json({ models: [], error: "Credential not found" });
      baseUrl = (body.base_url ?? saved.base_url ?? "").replace(/\/$/, "");
      apiKey = body.api_key ?? saved.api_key;
      protoType = body.proto_type ?? saved.proto_type;
    } catch (err) {
      if (err instanceof CredentialKeyUnavailableError) {
        return c.json({ models: [], error: "凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。" }, 409);
      }
      if (err instanceof CredentialDecryptError) {
        return c.json({ models: [], error: "Credential cannot be decrypted with current master key. Re-enter and save the API key." }, 409);
      }
      throw err;
    }
  } else if (body.base_url) {
    // New credential or base_url override — use provided values
    baseUrl = body.base_url.replace(/\/$/, "");
    apiKey = body.api_key ?? "";
    protoType = body.proto_type ?? "openai";
  } else if (body.api_key) {
    // Only api_key provided
    baseUrl = "";
    apiKey = body.api_key;
    protoType = body.proto_type ?? "openai";
  } else {
    try {
      const ctx = queryContextFromUser(c.get("user"));
      const cred = await getDefaultCredential(ctx);
      if (!cred) return c.json({ models: [], error: "No credential configured" });
      baseUrl = (cred.base_url ?? "").replace(/\/$/, "");
      apiKey = cred.api_key;
      protoType = cred.proto_type;
    } catch (err) {
      if (err instanceof CredentialKeyUnavailableError) {
        return c.json({ models: [], error: "凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。" }, 409);
      }
      if (err instanceof CredentialDecryptError) {
        return c.json({ models: [], error: "Credential cannot be decrypted with current master key. Re-enter and save the API key." }, 409);
      }
      throw err;
    }
  }

  try {
    const base = baseUrl || (protoType === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
    const endpoint = base + "/models";

    const headers: Record<string, string> = {};
    if (protoType === "anthropic") {
      if (apiKey) headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return c.json({ models: [], error: `HTTP ${res.status}` });
    }

    const data = await res.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const models = (data.data ?? []).map((m) => {
      const meta = lookupModelMeta(m.id);
      return {
        id: m.id,
        owned_by: m.owned_by,
        reasoning: meta.reasoning,
        thinking_levels: meta.thinking_levels,
      };
    });
    return c.json({ models });
  } catch (err) {
    logger.warn({ err }, "Failed to list models");
    return c.json({ models: [], error: String(err) });
  }
});

// system-config + smtp admin endpoints moved to /api/admin/* (admin-api only)

// ─── Report Skills (user-owned) — must live under settingsRouter so
// /api/settings/* is not 404'd by this router before reportsRouter. ───

// GET /api/settings/skills
settingsRouter.get("/skills", async (c) => {
  const user = c.get("user");
  const skills = await reportStorage.listSkills(user.userId);
  return c.json({ skills });
});

// POST /api/settings/skills — upload skill zip
settingsRouter.post("/skills", async (c) => {
  const user = c.get("user");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) throw new AppError("ERR_VALIDATION");

  const maxBytes = 50 * 1024 * 1024; // 50MB
  if (file.size > maxBytes) {
    throw new AppError("ERR_UPLOAD_TOO_LARGE");
  }

  const config = loadConfig();
  const name = (formData.get("name") as string | null) || file.name.replace(/\.zip$/i, "");
  const description = (formData.get("description") as string | null) || "";

  const minioKey = `report-skills/${crypto.randomUUID()}.zip`;
  const buf = Buffer.from(await file.arrayBuffer());
  try {
    await uploadFile(config.minio.bucket, minioKey, buf, buf.length);
  } catch (err) {
    logger.error({ err }, "skill upload to MinIO failed");
    throw new AppError("ERR_INTERNAL", { details: { phase: "upload" } });
  }

  const skill = await reportStorage.createSkill({
    name,
    description,
    minioKey,
    sizeBytes: file.size,
    attachmentCount: 0,
    uploadedBy: user.userId,
    ownerUserId: user.userId,
  });

  return c.json({ skill }, 201);
});

// DELETE /api/settings/skills/:id
settingsRouter.delete("/skills/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const skill = await reportStorage.deleteOwnedSkill(id, user.userId);
  if (!skill) throw new AppError("ERR_NOT_FOUND");

  const config = loadConfig();
  try {
    const minio = getMinio();
    await minio.removeObject(config.minio.bucket, skill.minio_key);
  } catch { /* best effort */ }

  return c.json({ ok: true });
});

