import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import {
  getDefaultCredential,
  listCredentials,
  deleteCredential,
  setDefaultCredential,
  upsertCredential,
  getSystemConfig,
  updateSystemConfig,
} from "./storage.js";
import { logger } from "../../infra/logger.js";
import { CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { diagnoseModelRuntimeCredential } from "./runtime-diagnostics.js";
import { getDiagnosticRun, startDiagnosticRun } from "./diagnostic-runs.js";
import { loadConfig } from "../../infra/config.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
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
    const cred = await getDefaultCredential();
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
settingsRouter.get("/credentials", requireAdmin, async (c) => {
  const creds = await listCredentials();
  return c.json({ credentials: creds });
});

// DELETE /api/settings/credentials/:id — delete a credential
settingsRouter.delete("/credentials/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const ok = await deleteCredential(id);
  if (!ok) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  return c.json({ ok: true });
});

// POST /api/settings/credentials/:id/default — set as default
settingsRouter.post("/credentials/:id/default", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await setDefaultCredential(id);
  return c.json({ ok: true });
});

// PUT /api/settings/credential — save/update LLM credential (admin only)
settingsRouter.put("/credential", requireAdmin, async (c) => {
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
  }>();

  if (!body.provider || !body.model_id || !body.base_url) {
    return c.json(
      { error: { code: "ERR_BAD_REQUEST", detail: "provider, base_url, model_id required" } },
      400,
    );
  }

  let contextWindowTokens: number;
  try {
    contextWindowTokens = parseContextWindowTokens(body.context_window_tokens);
  } catch {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "invalid context_window_tokens" } }, 400);
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
    });
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      return c.json({ error: { code: "ERR_CREDENTIAL_KEY_UNAVAILABLE", message: "凭证加密 key 未配置。请管理员设置 VULNHUNT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。" } }, 409);
    }
    throw err;
  }

  return c.json({ id });
});

// PATCH /api/settings/credential/:id — update metadata without re-entering API key
settingsRouter.patch("/credential/:id", requireAdmin, async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json<{
    provider?: string;
    proto_type?: string;
    base_url?: string;
    model_id?: string;
    thinking_effort?: string;
    label?: string;
    context_window_tokens?: number;
  }>();

  let contextWindowTokens: number | undefined;
  if (body.context_window_tokens !== undefined) {
    try {
      contextWindowTokens = parseContextWindowTokens(body.context_window_tokens);
    } catch {
      return c.json({ error: { code: "ERR_BAD_REQUEST", detail: "invalid context_window_tokens" } }, 400);
    }
  }

  const { updateCredentialMeta } = await import("./storage.js");
  await updateCredentialMeta({
    id,
    provider: body.provider,
    protoType: body.proto_type,
    baseUrl: body.base_url,
    modelId: body.model_id,
    thinkingEffort: body.thinking_effort,
    label: body.label,
    contextWindowTokens,
  });

  return c.json({ ok: true });
});

// POST /api/settings/credential/test — test LLM connection
settingsRouter.post("/credential/test", requireAdmin, async (c) => {
  const body = await c.req.json<{
    credential_id?: string; // test using saved credential
    proto_type?: string;
    base_url?: string;
    model_id?: string;
    api_key?: string;
    thinking_effort?: string;
    context_window_tokens?: number;
    async?: boolean;
  }>();

  let protoType = body.proto_type ?? "";
  let baseUrl = (body.base_url ?? "").replace(/\/$/, "");
  let modelId = body.model_id ?? "";
  let apiKey = body.api_key ?? "";
  let thinkingEffort = body.thinking_effort;
  let contextWindowTokens = body.context_window_tokens ?? 128000;

  // If credential_id provided, load saved credential
  if (body.credential_id) {
    const { getCredentialById } = await import("./storage.js");
    try {
      const cred = await getCredentialById(body.credential_id);
      if (!cred) return c.json({ ok: false, error: "Credential not found" }, 404);
      protoType = protoType || cred.proto_type;
      baseUrl = baseUrl || (cred.base_url ?? "").replace(/\/$/, "");
      modelId = modelId || cred.model_id;
      apiKey = apiKey || cred.api_key;
      thinkingEffort = thinkingEffort ?? cred.thinking_effort;
      contextWindowTokens = cred.context_window_tokens ?? contextWindowTokens;
    } catch (err) {
      if (err instanceof CredentialKeyUnavailableError) {
        return c.json({ ok: false, error: "凭证加密 key 未配置。请管理员设置 VULNHUNT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。" }, 409);
      }
      if (err instanceof CredentialDecryptError) {
        return c.json({ ok: false, error: "Credential cannot be decrypted with current master key. Re-enter and save the API key." }, 409);
      }
      throw err;
    }
  }

  const user = c.get("user");
  const cred = {
    id: body.credential_id ?? "diagnostic",
    tenant_id: user.tenantId,
    provider: "diagnostic",
    proto_type: protoType,
    base_url: baseUrl,
    model_id: modelId,
    thinking_effort: thinkingEffort,
    api_key: apiKey,
    context_window_tokens: contextWindowTokens,
    is_default: false,
    created_at: new Date(),
    updated_at: new Date(),
  } as any;
  if (body.async) {
    const runId = startDiagnosticRun(cred, loadConfig(), { userId: user.userId, tenantId: user.tenantId, role: user.role === "admin" ? "admin" : "user" });
    return c.json({ ok: true, run_id: runId, diagnostics: getDiagnosticRun(runId) });
  }
  const diagnostics = await diagnoseModelRuntimeCredential(cred, loadConfig(), { userId: user.userId, tenantId: user.tenantId, role: user.role === "admin" ? "admin" : "user" });
  return c.json({
    ok: diagnostics.ok,
    message: diagnostics.summary,
    error: diagnostics.ok ? undefined : diagnostics.summary,
    diagnostics,
  });
});

settingsRouter.get("/credential/test-runs/:id", requireAdmin, async (c) => {
  const run = getDiagnosticRun(c.req.param("id"));
  if (!run) return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  return c.json(run);
});

// POST /api/settings/models — list models using provided or saved credential
settingsRouter.post("/models", requireAdmin, async (c) => {
  const body = await c.req.json<{ base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }>().catch(() => ({} as { base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }));

  // Use form values if provided, otherwise fall back to saved/default credential
  let baseUrl: string;
  let apiKey: string;
  let protoType: string;

  if (body.credential_id) {
    // Editing existing credential: use saved api_key, override base_url if provided
    const { getCredentialById } = await import("./storage.js");
    try {
      const saved = await getCredentialById(body.credential_id);
      if (!saved) return c.json({ models: [], error: "Credential not found" });
      baseUrl = (body.base_url ?? saved.base_url ?? "").replace(/\/$/, "");
      apiKey = body.api_key ?? saved.api_key;
      protoType = body.proto_type ?? saved.proto_type;
    } catch (err) {
      if (err instanceof CredentialKeyUnavailableError) {
        return c.json({ models: [], error: "凭证加密 key 未配置。请管理员设置 VULNHUNT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。" }, 409);
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
      const cred = await getDefaultCredential();
      if (!cred) return c.json({ models: [], error: "No credential configured" });
      baseUrl = (cred.base_url ?? "").replace(/\/$/, "");
      apiKey = cred.api_key;
      protoType = cred.proto_type;
    } catch (err) {
      if (err instanceof CredentialKeyUnavailableError) {
        return c.json({ models: [], error: "凭证加密 key 未配置。请管理员设置 VULNHUNT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。" }, 409);
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
    const models = (data.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by }));
    return c.json({ models });
  } catch (err) {
    logger.warn({ err }, "Failed to list models");
    return c.json({ models: [], error: String(err) });
  }
});

// GET /api/settings/system — system config
settingsRouter.get("/system", requireAdmin, async (c) => {
  const config = await getSystemConfig();
  return c.json({ config });
});

// PATCH /api/settings/system — update system config
settingsRouter.patch("/system", requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  try {
    await updateSystemConfig(body);
  } catch (err) {
    return c.json({ error: { code: "ERR_BAD_REQUEST", detail: err instanceof Error ? err.message : "invalid system config" } }, 400);
  }
  return c.json({ ok: true });
});
