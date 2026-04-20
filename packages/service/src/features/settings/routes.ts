import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import {
  getDefaultCredential,
  upsertCredential,
  getSystemConfig,
  updateSystemConfig,
} from "./storage.js";

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

// PUT /api/settings/credential — save/update LLM credential (admin only)
settingsRouter.put("/credential", requireAdmin, async (c) => {
  const body = await c.req.json<{
    provider: string;
    proto_type: string;
    base_url?: string;
    model_id: string;
    thinking_effort?: string;
    label?: string;
    api_key: string;
  }>();

  if (!body.provider || !body.model_id || !body.api_key) {
    return c.json(
      { error: { code: "ERR_INTERNAL", detail: "provider, model_id, api_key required" } },
      400,
    );
  }

  const id = await upsertCredential({
    provider: body.provider,
    protoType: body.proto_type,
    baseUrl: body.base_url,
    modelId: body.model_id,
    thinkingEffort: body.thinking_effort,
    label: body.label,
    apiKey: body.api_key,
  });

  return c.json({ id });
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
