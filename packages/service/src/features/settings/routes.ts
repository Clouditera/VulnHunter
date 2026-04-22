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
  const { api_key: _ak, api_key_ciphertext: _c, api_key_iv: _i, api_key_tag: _t, ...safe } = cred as typeof cred & Record<string, unknown>;
  return c.json({ credential: safe });
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

// POST /api/settings/credential/test — test LLM connection
settingsRouter.post("/credential/test", requireAdmin, async (c) => {
  const body = await c.req.json<{
    proto_type: string;
    base_url?: string;
    model_id: string;
    api_key: string;
  }>();

  if (!body.api_key || !body.model_id) {
    return c.json({ ok: false, error: "api_key and model_id required" }, 400);
  }

  const baseUrl = (body.base_url ?? "").replace(/\/$/, "");

  try {
    // Try a minimal chat completion request
    // base_url may already include /v1 (e.g. http://host/v1), so use it as-is if present
    const base = baseUrl || (body.proto_type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
    const endpoint = body.proto_type === "anthropic"
      ? base + "/messages"
      : base + "/chat/completions";

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let reqBody: string;

    if (body.proto_type === "anthropic") {
      headers["x-api-key"] = body.api_key;
      headers["anthropic-version"] = "2023-06-01";
      reqBody = JSON.stringify({
        model: body.model_id,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
    } else {
      headers["Authorization"] = `Bearer ${body.api_key}`;
      reqBody = JSON.stringify({
        model: body.model_id,
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

// GET /api/settings/models — list available models from configured endpoint
settingsRouter.get("/models", requireAdmin, async (c) => {
  const cred = await getDefaultCredential();
  if (!cred) return c.json({ models: [], error: "No credential configured" });

  const baseUrl = (cred.base_url ?? "").replace(/\/$/, "");

  try {
    const base = baseUrl || (cred.proto_type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
    const endpoint = base + "/models";

    const headers: Record<string, string> = {};
    if (cred.proto_type === "anthropic") {
      headers["x-api-key"] = cred.api_key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${cred.api_key}`;
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
