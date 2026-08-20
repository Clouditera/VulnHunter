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
import { runPiDiagnostics, type DiagnosticCheck, type DiagnosticEvent } from "./pi-diagnostics.js";
import { updateDeepVerifiedStatus } from "./storage.js";
import { createHash } from "node:crypto";
import { coreFieldsChanged, effectiveApiKey } from "./credential-core-fields.js";
import { loadConfig } from "../../infra/config.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import * as reportStorage from "../reports/storage.js";
import { uploadFile, getMinio } from "../../infra/minio/client.js";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const VALID_PROTO_TYPES = new Set(["openai-completions", "openai-responses", "anthropic", "openai"]);
function parseContextWindowTokens(value: unknown): number {
  if (value == null) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid context_window_tokens");
  const tokens = Math.trunc(value);
  if (tokens < 1000 || tokens > 10000000) throw new Error("invalid context_window_tokens");
  return tokens;
}

/**
 * L4 is the fourth gate layer (fish 2026-08-05): the test stream runs
 * L1→L2→L3→L4 and only all-pass permits save. L4 is slow (real pi agent,
 * up to ~60s), so the save gate reuses a fresh L4 verdict instead of
 * re-running it: lastTestPass is keyed by a fingerprint of the exact
 * credential payload (incl. key hash) and is written only by the
 * server-side stream — the UI cannot forge it.
 */
const LAST_TEST_TTL_MS = 5 * 60_000;
const lastTestPass = new Map<string, { at: number; ok: boolean }>();

/** Stable fingerprint of the advanced_config payload for test-cache keys. */
function advancedConfigFingerprint(cfg: unknown): string {
  if (cfg == null) return "";
  // Canonical JSON: sort top-level keys so key order doesn't bust the cache.
  try {
    const obj = typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as Record<string, unknown>) : { raw: cfg };
    const keys = Object.keys(obj).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = obj[k];
    return JSON.stringify(ordered);
  } catch {
    return String(cfg);
  }
}

/** Compare two advanced_config values for equality (null/undefined both = empty). */
function advancedConfigEqual(a: unknown, b: unknown): boolean {
  return advancedConfigFingerprint(a ?? null) === advancedConfigFingerprint(b ?? null);
}

function credentialFingerprint(cred: {
  proto_type: string;
  base_url: string;
  model_id: string;
  thinking_effort?: string;
  api_key: string;
  /** fish 2026-08-09: include advanced_config so send-value / compat changes bust cache */
  advanced_config?: unknown;
}): string {
  const h = createHash("sha256");
  h.update(cred.proto_type);
  h.update("|");
  h.update(cred.base_url);
  h.update("|");
  h.update(cred.model_id);
  h.update("|");
  h.update(cred.thinking_effort ?? "");
  h.update("|");
  h.update(createHash("sha256").update(cred.api_key).digest("hex"));
  h.update("|");
  h.update(advancedConfigFingerprint(cred.advanced_config ?? null));
  return h.digest("hex");
}

function recordTestPass(cred: Parameters<typeof credentialFingerprint>[0], ok: boolean): void {
  lastTestPass.set(credentialFingerprint(cred), { at: Date.now(), ok });
}

function freshTestPass(cred: Parameters<typeof credentialFingerprint>[0]): boolean | null {
  const fp = credentialFingerprint(cred);
  const entry = lastTestPass.get(fp);
  if (!entry) return null;
  if (Date.now() - entry.at > LAST_TEST_TTL_MS) {
    lastTestPass.delete(fp);
    return null;
  }
  return entry.ok;
}

/** Run L1-L3 (+ L4 when L1-L3 pass) and emit every event; returns merged result. */
/**
 * Four-in-one diagnostics (fish/architect 2026-08-08): a single pi CLI run
 * produces all four layer assertions (L1-L4) from the same event stream.
 * No separate L4 call — runPiDiagnostics returns all four checks.
 */
async function runFullDiagnostics(
  cred: Parameters<typeof credentialFingerprint>[0] & { context_window_tokens?: number },
  emit: (event: DiagnosticEvent) => void,
): Promise<{ ok: boolean; checks: DiagnosticCheck[] }> {
  const diag = await runPiDiagnostics(cred as any, emit);
  recordTestPass(cred, diag.ok);
  return diag;
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

// GET /api/settings/credentials/:id/key — reveal a saved key on explicit user action.
// getCredentialById applies the same admin/member visibility rules as editing.
settingsRouter.get("/credentials/:id/key", async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const id = c.req.param("id");
  try {
    const cred = await getCredentialById(ctx, id);
    if (!cred) throw new AppError("ERR_NOT_FOUND");
    logger.info({ credentialId: id, userId: ctx.userId }, "Credential API key revealed");
    return c.json({ api_key: cred.api_key });
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      throw new AppError("ERR_CREDENTIAL_KEY_UNAVAILABLE");
    }
    if (err instanceof CredentialDecryptError) {
      throw new AppError("ERR_CREDENTIAL_DECRYPT_FAILED");
    }
    throw err;
  }
});

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
    advanced_config?: unknown;
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

  // ── Edit gate refinement (fish 2026-08-04): core-field changes
  // (proto/base_url/api_key/model_id/thinking) require a fresh test;
  // optional-only edits (label, context_window) save directly. ──
  let coreChanged = true;
  let effectiveKey = body.api_key;
  let existingCred: Awaited<ReturnType<typeof getCredentialById>> = null;
  if (body.id) {
    existingCred = await getCredentialById(ctx, body.id).catch(() => null);
    if (!existingCred) throw new AppError("ERR_NOT_FOUND");
    effectiveKey = effectiveApiKey(existingCred, body);
    coreChanged = coreFieldsChanged(existingCred, body);
  }

  // Validate advanced_config if present (fish 2026-08-08: unified credential module).
  // fish 2026-08-09: only force coreChanged when the value *actually differs*
  // from what's stored. Frontend always sends the sparse advanced_config on
  // save (even when untouched) — treating presence as a change forced a
  // silent re-gate that ignored the just-passed test fingerprint (missing
  // advanced_config in the fingerprint made cache miss worse).
  let validatedAdvancedConfig: unknown = undefined;
  if (body.advanced_config !== undefined) {
    try {
      const { validateAdvancedConfig } = await import("./credential-models.js");
      // null = explicit clear; object = validate
      validatedAdvancedConfig =
        body.advanced_config === null ? null : validateAdvancedConfig(body.advanced_config);
    } catch (err: any) {
      throw new AppError("ERR_VALIDATION", { details: { field: "advanced_config", reason: err?.message } });
    }
    if (body.id) {
      const stored = existingCred?.advanced_config ?? null;
      if (!advancedConfigEqual(validatedAdvancedConfig, stored)) {
        coreChanged = true;
      }
    } else if (validatedAdvancedConfig != null) {
      coreChanged = true;
    }
  }

  // ── Save gate: all four layers must pass before persisting (fish
  // 2026-08-05: L4 joined the stream as the 4th layer and save requires
  // all-pass). A fresh server-side test verdict (same payload fingerprint,
  // < 5 min) is reused so the just-run test isn't re-burned; otherwise the
  // full L1-L3+L4 gate runs here. ──
  if (coreChanged) {
    const gateCred = {
      id: body.id ?? "gate",
      provider: body.provider,
      proto_type: body.proto_type,
      base_url: body.base_url!,
      model_id: body.model_id,
      thinking_effort: body.thinking_effort,
      api_key: effectiveKey,
      context_window_tokens: contextWindowTokens,
      // Prefer body-validated config; else stored — same as diagnose-stream
      // fallback, so the test-pass cache key matches the just-run diagnose.
      advanced_config:
        validatedAdvancedConfig !== undefined
          ? validatedAdvancedConfig
          : (existingCred?.advanced_config ?? null),
      is_default: false,
      created_at: new Date(),
      updated_at: new Date(),
    } as any;
    const cached = freshTestPass(gateCred);
    const gateResult = cached === null
      ? await runFullDiagnostics(gateCred, () => {})
      : { ok: cached, checks: [] as DiagnosticCheck[] };
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
      advancedConfig: validatedAdvancedConfig,
      ctx,
    });
  } catch (err) {
    if (err instanceof CredentialKeyUnavailableError) {
      throw new AppError("ERR_CREDENTIAL_KEY_UNAVAILABLE");
    }
    throw err;
  }

  if (body.id && !id) throw new AppError("ERR_NOT_FOUND");

  // L4 verdict for backfill-on-open (fish 2026-08-05): the gate already ran
  // L4 (or reused a fresh server-side pass), so just persist the verdict —
  // no second agent run. Optional-only edits keep the previous verdict.
  if (coreChanged) {
    await updateDeepVerifiedStatus(id, "passed").catch(() => undefined);
  }
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

  // Single-gate rule (fish 2026-08-04 P1, +thinking_effort 2026-08-06):
  // core fields are refused here — they must go through PUT /credential
  // which enforces the L1-L3 gate. thinking_effort joined the core set
  // (QA-caught side door: direct PATCH changed thinking without a test).
  // api_key is not in this endpoint's body type at all — key material is
  // only ever written by PUT (upsert), never PATCH.
  // PATCH serves optional metadata only (label/context window).
  for (const field of ["proto_type", "base_url", "model_id", "thinking_effort"] as const) {
    if (body[field] !== undefined) {
      throw new AppError("ERR_CREDENTIAL_CORE_FIELD_REQUIRES_TEST", { details: { field } });
    }
  }

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
    context_window_tokens?: number;
    /** Form advanced_config (fish 2026-08-09: test what you see — form wins over saved). */
    advanced_config?: unknown;
  }>();

  let protoType = body.proto_type ?? "";
  let baseUrl = (body.base_url ?? "").replace(/\/+$/, "");
  let modelId = body.model_id ?? "";
  let apiKey = body.api_key ?? "";
  let thinkingEffort = body.thinking_effort;
  let contextWindowTokens: number | undefined =
    typeof body.context_window_tokens === "number" && Number.isFinite(body.context_window_tokens)
      ? body.context_window_tokens
      : undefined;

  // Load saved credential if id provided (form values already win via || / ?? below)
  let savedAdvancedConfig: unknown = null;
  if (body.credential_id) {
    const ctx = queryContextFromUser(c.get("user"));
    const saved = await getCredentialById(ctx, body.credential_id);
    if (!saved) throw new AppError("ERR_NOT_FOUND");
    protoType = protoType || saved.proto_type;
    baseUrl = baseUrl || (saved.base_url ?? "").replace(/\/+$/, "");
    modelId = modelId || saved.model_id;
    apiKey = apiKey || saved.api_key;
    thinkingEffort = thinkingEffort ?? saved.thinking_effort;
    if (contextWindowTokens === undefined) {
      contextWindowTokens = saved.context_window_tokens ?? undefined;
    }
    savedAdvancedConfig = saved.advanced_config ?? null;
  }

  // advanced_config: form value preferred over saved (fish 2026-08-09 所见即所得).
  // body.advanced_config === undefined → fall back to saved;
  // body.advanced_config === null → explicitly clear (no advanced config for this test).
  let advancedConfig: unknown = savedAdvancedConfig;
  if (body.advanced_config !== undefined) {
    if (body.advanced_config === null) {
      advancedConfig = null;
    } else {
      try {
        const { validateAdvancedConfig } = await import("./credential-models.js");
        advancedConfig = validateAdvancedConfig(body.advanced_config);
      } catch (err: any) {
        throw new AppError("ERR_VALIDATION", {
          details: { field: "advanced_config", reason: err?.message },
        });
      }
    }
  }

  const cred = {
    id: body.credential_id ?? "diagnostic",
    provider: "diagnostic",
    proto_type: protoType,
    base_url: baseUrl,
    model_id: modelId,
    thinking_effort: thinkingEffort,
    api_key: apiKey,
    // Form → saved → hard default 128000 (fish 2026-08-09: no more hard-code-only)
    context_window_tokens: contextWindowTokens ?? 128000,
    advanced_config: advancedConfig,
    is_default: false,
    created_at: new Date(),
    updated_at: new Date(),
  } as any;

  return streamSSE(c, async (stream) => {
    // B1 (QA-caught): L4's terminal frames were written synchronously right
    // before the callback resolved — hono closed the response and the queued
    // writes were dropped (panel stuck on 测试中…). Serialize writes on a
    // promise chain and await it before returning so every frame hits the
    // wire, in order.
    let writeChain: Promise<void> = Promise.resolve();
    const emit = (event: DiagnosticEvent) => {
      writeChain = writeChain.then(() =>
        stream.writeSSE({ data: JSON.stringify(event) }).then(() => undefined),
      );
    };
    // Heartbeat (fish 2026-08-07): L4 agent circuit can have 60s+ silent
    // periods; nginx/intermediaries with a 60s read-timeout would kill the
    // connection. A 30s SSE comment frame (": ping\n\n") keeps it alive —
    // same pattern as the notifications channel. Comment frames are ignored
    // by the browser EventSource but reset intermediary idle timers.
    const heartbeat = setInterval(() => {
      writeChain = writeChain.then(() =>
        stream.write(": ping\n\n").then(() => undefined),
      );
    }, 30_000);
    const stopHeartbeat = () => clearInterval(heartbeat);
    stream.onAbort(stopHeartbeat);
    try {
      await runFullDiagnostics(cred, emit);
      await writeChain;
    } finally {
      stopHeartbeat();
    }
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
    // Model thinking-support gating removed (fish 2026-08-20): the frozen
    // pi static catalog cannot know new models — unknown ≠ unsupported.
    // The L2 thinking probe in credential testing is the source of truth.
    const models = (data.data ?? []).map((m) => ({ id: m.id, owned_by: m.owned_by }));
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

