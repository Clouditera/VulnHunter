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

export const settingsRouter = new Hono();
settingsRouter.use("*", licenseGuard);
settingsRouter.use("*", requireAuth);

// GET /api/settings/credential — show active LLM credential (no api_key)
settingsRouter.get("/credential", async (c) => {
  const cred = await getDefaultCredential();
  if (!cred) return c.json({ credential: null });
  const key = cred.api_key;
  const masked_key = key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : "••••••••";
  const { api_key: _ak, api_key_ciphertext: _c, api_key_iv: _i, api_key_tag: _t, ...safe } = cred as typeof cred & Record<string, unknown>;
  return c.json({ credential: { ...safe, masked_key } });
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
  }>();

  if (!body.provider || !body.model_id || !body.api_key) {
    return c.json(
      { error: { code: "ERR_INTERNAL", detail: "provider, model_id, api_key required" } },
      400,
    );
  }

  const id = await upsertCredential({
    id: body.id,
    provider: body.provider,
    protoType: body.proto_type,
    baseUrl: body.base_url,
    modelId: body.model_id,
    thinkingEffort: body.thinking_effort,
    label: body.label,
    apiKey: body.api_key,
    isDefault: body.is_default,
  });

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
  }>();

  const { updateCredentialMeta } = await import("./storage.js");
  await updateCredentialMeta({
    id,
    provider: body.provider,
    protoType: body.proto_type,
    baseUrl: body.base_url,
    modelId: body.model_id,
    thinkingEffort: body.thinking_effort,
    label: body.label,
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
  }>();

  let protoType = body.proto_type ?? "";
  let baseUrl = (body.base_url ?? "").replace(/\/$/, "");
  let modelId = body.model_id ?? "";
  let apiKey = body.api_key ?? "";

  // If credential_id provided, load saved credential
  if (body.credential_id) {
    const { getCredentialById } = await import("./storage.js");
    const cred = await getCredentialById(body.credential_id);
    if (!cred) return c.json({ ok: false, error: "Credential not found" }, 404);
    protoType = protoType || cred.proto_type;
    baseUrl = baseUrl || (cred.base_url ?? "").replace(/\/$/, "");
    modelId = modelId || cred.model_id;
    apiKey = apiKey || cred.api_key;
  }

  if (!apiKey || !modelId) {
    return c.json({ ok: false, error: "api_key and model_id required (provide directly or via credential_id)" }, 400);
  }

  try {
    // Try a minimal chat completion request
    // base_url may already include /v1 (e.g. http://host/v1), so use it as-is if present
    const base = baseUrl || (protoType === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");

    // Use the actual API format based on proto_type — so test results match scan behavior
    let endpoint: string;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let reqBody: string;

    if (protoType === "anthropic") {
      endpoint = base + "/messages";
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      reqBody = JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
    } else if (protoType === "openai-responses") {
      endpoint = base + "/responses";
      headers["Authorization"] = `Bearer ${apiKey}`;
      reqBody = JSON.stringify({
        model: modelId,
        max_output_tokens: 1,
        input: "hi",
      });
    } else {
      // openai-completions (default for most endpoints)
      endpoint = base + "/chat/completions";
      headers["Authorization"] = `Bearer ${apiKey}`;
      reqBody = JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
    }

    const res = await fetch(endpoint, { method: "POST", headers, body: reqBody, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      return c.json({ ok: true, message: "Connection successful" });
    }
    const errBody = await res.text().catch(() => "");
    return c.json({ ok: false, error: `HTTP ${res.status}: ${errBody.slice(0, 200)}` });
  } catch (err) {
    return c.json({ ok: false, error: String(err) });
  }
});

// POST /api/settings/models — list models using provided or saved credential
settingsRouter.post("/models", requireAdmin, async (c) => {
  const body = await c.req.json<{ base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }>().catch(() => ({} as { base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }));

  // Use form values if provided, otherwise fall back to saved/default credential
  let baseUrl: string;
  let apiKey: string;
  let protoType: string;

  if (body.base_url && body.api_key) {
    // Both provided from form (new credential)
    baseUrl = body.base_url.replace(/\/$/, "");
    apiKey = body.api_key;
    protoType = body.proto_type ?? "openai";
  } else if (body.credential_id) {
    // Editing existing credential: use saved api_key, override base_url if provided
    const { getCredentialById } = await import("./storage.js");
    const saved = await getCredentialById(body.credential_id);
    if (!saved) return c.json({ models: [], error: "Credential not found" });
    baseUrl = (body.base_url ?? saved.base_url ?? "").replace(/\/$/, "");
    apiKey = saved.api_key;
    protoType = body.proto_type ?? saved.proto_type;
  } else {
    const cred = await getDefaultCredential();
    if (!cred) return c.json({ models: [], error: "No credential configured" });
    baseUrl = (cred.base_url ?? "").replace(/\/$/, "");
    apiKey = cred.api_key;
    protoType = cred.proto_type;
  }

  try {
    const base = baseUrl || (protoType === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
    const endpoint = base + "/models";

    const headers: Record<string, string> = {};
    if (protoType === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
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
  await updateSystemConfig(body);
  return c.json({ ok: true });
});
