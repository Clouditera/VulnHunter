import { getDb } from "../../infra/db/client.js";
import { MasterKeyVault, CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { join } from "node:path";
import type { QueryContext } from "../../infra/query-context.js";
import { shouldFilterByUser } from "../../infra/query-context.js";
import { deploymentUploadCeilingMb, normalizeSourceArchiveUploadMaxMb } from "../source-archives/limits.js";

let _vault: MasterKeyVault | null = null;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
function normalizeContextWindowTokens(value?: number | null): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.trunc(value!);
}
let _vaultUnavailableReason: string | null = null;

export function initVault(dataDir: string): void {
  const keyPath = process.env.VULNHUNTER_MASTER_KEY_FILE
    ?? (process.env.VULNHUNTER_ALLOW_DATA_DIR_MASTER_KEY_FALLBACK === "1" ? join(dataDir, ".master.key") : undefined);
  if (!keyPath) {
    _vault = null;
    _vaultUnavailableReason = "VULNHUNTER_MASTER_KEY_FILE is not configured";
    return;
  }
  try {
    _vault = new MasterKeyVault(keyPath);
    _vaultUnavailableReason = null;
  } catch (err) {
    _vault = null;
    _vaultUnavailableReason = err instanceof Error ? err.message : String(err);
  }
}

function getVault(): MasterKeyVault {
  if (!_vault) {
    throw new CredentialKeyUnavailableError(
      "凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。",
    );
  }
  return _vault;
}

/** Optional vault accessor for features that degrade when master key is missing. */
export function getVaultOptional(): MasterKeyVault | null {
  return _vault;
}

export function getCredentialCryptoStatus():
  | { state: "available"; currentKeyFingerprint: string }
  | { state: "key_unavailable"; reason: string | null } {
  if (!_vault) return { state: "key_unavailable", reason: _vaultUnavailableReason };
  return { state: "available", currentKeyFingerprint: _vault.fingerprint() };
}

export interface DbLlmCredential {
  id: string;
  provider: string;
  proto_type: string;
  base_url: string | null;
  model_id: string;
  thinking_effort: string;
  label: string;
  is_default: boolean;
  key_fingerprint: string | null;
  context_window_tokens: number;
  owner_id: string | null;
  deep_verified_status: string | null;
  deep_verified_at: Date | null;
}

export interface DecryptedLlmCredential extends DbLlmCredential {
  api_key: string;
  scope: "global" | "personal";
}

export async function getDefaultCredential(): Promise<DecryptedLlmCredential | null>;
export async function getDefaultCredential(ctx: QueryContext): Promise<DecryptedLlmCredential | null>;
export async function getDefaultCredential(ctx?: QueryContext): Promise<DecryptedLlmCredential | null> {
  const db = getDb();
  const rows = ctx && shouldFilterByUser(ctx)
    ? await db<(DbLlmCredential & {
      api_key_ciphertext: Buffer | null;
      api_key_iv: Buffer | null;
      api_key_tag: Buffer | null;
    })[]>`
      SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
             key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag
      FROM llm_credentials
      WHERE is_default = true AND (owner_id = ${ctx.userId} OR owner_id IS NULL)
      ORDER BY owner_id NULLS LAST, created_at DESC
      LIMIT 1
    `
    : await db<(DbLlmCredential & {
      api_key_ciphertext: Buffer | null;
      api_key_iv: Buffer | null;
      api_key_tag: Buffer | null;
    })[]>`
      SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
             key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag
      FROM llm_credentials
      WHERE is_default = true
      ORDER BY created_at DESC
      LIMIT 1
    `;

  if (!rows[0]) return null;
  return decryptRow(rows[0]);
}

export async function getCredentialById(id: string): Promise<DecryptedLlmCredential | null>;
export async function getCredentialById(ctx: QueryContext, id: string): Promise<DecryptedLlmCredential | null>;
export async function getCredentialById(ctxOrId: QueryContext | string, maybeId?: string): Promise<DecryptedLlmCredential | null> {
  const db = getDb();
  const ctx = typeof ctxOrId === "string" ? undefined : ctxOrId;
  const id = typeof ctxOrId === "string" ? ctxOrId : maybeId!;
  const rows = ctx && shouldFilterByUser(ctx)
    ? await db<(DbLlmCredential & {
      api_key_ciphertext: Buffer | null;
      api_key_iv: Buffer | null;
      api_key_tag: Buffer | null;
    })[]>`
      SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
             key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag
      FROM llm_credentials
      WHERE id = ${id} AND (owner_id = ${ctx.userId} OR owner_id IS NULL)
      LIMIT 1
    `
    : await db<(DbLlmCredential & {
      api_key_ciphertext: Buffer | null;
      api_key_iv: Buffer | null;
      api_key_tag: Buffer | null;
    })[]>`
      SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
             key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag
      FROM llm_credentials
      WHERE id = ${id}
      LIMIT 1
    `;
  if (!rows[0]) return null;
  return decryptRow(rows[0]);
}

export async function getDefaultOrFirstAvailableCredential(): Promise<DecryptedLlmCredential | null>;
export async function getDefaultOrFirstAvailableCredential(ctx: QueryContext): Promise<DecryptedLlmCredential | null>;
export async function getDefaultOrFirstAvailableCredential(ctx?: QueryContext): Promise<DecryptedLlmCredential | null> {
  const defaultCredential = await getDefaultCredential(ctx as any);
  if (defaultCredential) return defaultCredential;

  const db = getDb();
  const rows = await db<(DbLlmCredential & {
    api_key_ciphertext: Buffer | null;
    api_key_iv: Buffer | null;
    api_key_tag: Buffer | null;
  })[]>`
    SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
           key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag
    FROM llm_credentials
    ORDER BY is_default DESC, created_at DESC
  `;

  const visibleRows = ctx && shouldFilterByUser(ctx) ? rows.filter((row) => row.owner_id === null || row.owner_id === ctx.userId) : rows;
  for (const row of visibleRows) {
    try {
      return decryptRow(row);
    } catch (err) {
      if (err instanceof CredentialDecryptError) continue;
      throw err;
    }
  }
  return null;
}

export interface ListedLlmCredential extends DbLlmCredential {
  masked_key: string;
  credential_health: "ok" | "decrypt_failed" | "key_unavailable" | "unknown";
  current_key_fingerprint: string;
  owner_id: string | null;
  scope: "global" | "personal";
  can_edit: boolean;
}

export async function listCredentials(): Promise<ListedLlmCredential[]>;
export async function listCredentials(ctx: QueryContext): Promise<ListedLlmCredential[]>;
export async function listCredentials(ctx?: QueryContext): Promise<ListedLlmCredential[]> {
  const db = getDb();
  const rows = ctx && shouldFilterByUser(ctx)
    ? await db<(DbLlmCredential & {
      api_key_ciphertext: Buffer | null;
      api_key_iv: Buffer | null;
      api_key_tag: Buffer | null;
    })[]>`
      SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
             key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag, deep_verified_status, deep_verified_at
      FROM llm_credentials
      WHERE owner_id IS NULL OR owner_id = ${ctx.userId}
      ORDER BY is_default DESC, owner_id NULLS FIRST, created_at DESC
    `
    : await db<(DbLlmCredential & {
      api_key_ciphertext: Buffer | null;
      api_key_iv: Buffer | null;
      api_key_tag: Buffer | null;
    })[]>`
      SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
             key_fingerprint, context_window_tokens, owner_id, api_key_ciphertext, api_key_iv, api_key_tag, deep_verified_status, deep_verified_at
      FROM llm_credentials
      ORDER BY is_default DESC, owner_id NULLS FIRST, created_at DESC
    `;

  const cryptoStatus = getCredentialCryptoStatus();
  const currentKeyFingerprint = cryptoStatus.state === "available" ? cryptoStatus.currentKeyFingerprint : "";

  return rows.map((row) => {
    if (cryptoStatus.state === "key_unavailable") {
      return {
        id: row.id,
        provider: row.provider,
        proto_type: row.proto_type,
        base_url: row.base_url,
        model_id: row.model_id,
        thinking_effort: row.thinking_effort,
        label: row.label,
        is_default: row.is_default,
        key_fingerprint: row.key_fingerprint,
        context_window_tokens: row.context_window_tokens ?? 128000,
        masked_key: "key 未配置",
        credential_health: "key_unavailable",
        current_key_fingerprint: currentKeyFingerprint,
        owner_id: row.owner_id,
        deep_verified_status: row.deep_verified_status ?? null,
        deep_verified_at: row.deep_verified_at ?? null,
        scope: row.owner_id ? "personal" : "global",
        can_edit: !ctx || ctx.role === "admin" || row.owner_id === ctx.userId,
      } as ListedLlmCredential;
    }

    let masked = "未设置";
    let health: ListedLlmCredential["credential_health"] = "ok";
    if (row.api_key_ciphertext && row.api_key_iv && row.api_key_tag) {
      const vault = getVault();
      masked = "••••••••";
      health = "unknown";
      try {
        const key = vault.decrypt({
          ciphertext: row.api_key_ciphertext,
          iv: row.api_key_iv,
          tag: row.api_key_tag,
        });
        health = "ok";
        if (key.length > 8) {
          masked = `${key.slice(0, 4)}••••${key.slice(-4)}`;
        }
      } catch (err) {
        if (err instanceof CredentialDecryptError) {
          masked = "无法解密";
          health = "decrypt_failed";
        }
      }
    }

    return {
      id: row.id,
      provider: row.provider,
      proto_type: row.proto_type,
      base_url: row.base_url,
      model_id: row.model_id,
      thinking_effort: row.thinking_effort,
      label: row.label,
      is_default: row.is_default,
      key_fingerprint: row.key_fingerprint,
      context_window_tokens: row.context_window_tokens ?? 128000,
      masked_key: masked,
      credential_health: health,
      current_key_fingerprint: currentKeyFingerprint,
      owner_id: row.owner_id,
      deep_verified_status: row.deep_verified_status ?? null,
      deep_verified_at: row.deep_verified_at ?? null,
      scope: row.owner_id ? "personal" : "global",
      can_edit: !ctx || ctx.role === "admin" || row.owner_id === ctx.userId,
    };
  });
}

export async function deleteCredential(id: string): Promise<boolean>;
export async function deleteCredential(ctx: QueryContext, id: string): Promise<boolean>;
export async function deleteCredential(ctxOrId: QueryContext | string, maybeId?: string): Promise<boolean> {
  const db = getDb();
  const ctx = typeof ctxOrId === "string" ? undefined : ctxOrId;
  const id = typeof ctxOrId === "string" ? ctxOrId : maybeId!;
  const rows = ctx && shouldFilterByUser(ctx)
    ? await db`DELETE FROM llm_credentials WHERE id = ${id} AND owner_id = ${ctx.userId} RETURNING id`
    : await db`DELETE FROM llm_credentials WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function setDefaultCredential(id: string): Promise<void>;
export async function setDefaultCredential(ctx: QueryContext, id: string): Promise<void>;
export async function setDefaultCredential(ctxOrId: QueryContext | string, maybeId?: string): Promise<void> {
  const db = getDb();
  const ctx = typeof ctxOrId === "string" ? undefined : ctxOrId;
  const id = typeof ctxOrId === "string" ? ctxOrId : maybeId!;
  if (ctx && shouldFilterByUser(ctx)) {
    await db`UPDATE llm_credentials SET is_default = false WHERE owner_id = ${ctx.userId}`;
    await db`UPDATE llm_credentials SET is_default = true WHERE id = ${id} AND owner_id = ${ctx.userId}`;
    return;
  }
  await db`UPDATE llm_credentials SET is_default = false WHERE is_default = true`;
  await db`UPDATE llm_credentials SET is_default = true WHERE id = ${id}`;
}

function decryptRow(row: DbLlmCredential & {
  api_key_ciphertext: Buffer | null;
  api_key_iv: Buffer | null;
  api_key_tag: Buffer | null;
}): DecryptedLlmCredential {
  if (!row.api_key_ciphertext || !row.api_key_iv || !row.api_key_tag) {
    return { ...row, scope: row.owner_id ? "personal" : "global", api_key: "" };
  }
  const apiKey = getVault().decrypt({
    ciphertext: row.api_key_ciphertext,
    iv: row.api_key_iv,
    tag: row.api_key_tag,
  });
  return { ...row, scope: row.owner_id ? "personal" : "global", api_key: apiKey };
}

/** Update credential metadata without changing the API key */
export async function updateCredentialMeta(params: {
  id: string;
  provider?: string;
  protoType?: string;
  baseUrl?: string;
  modelId?: string;
  thinkingEffort?: string;
  label?: string;
  contextWindowTokens?: number;
  ownerId?: string | null;
  ctx?: QueryContext;
}): Promise<boolean> {
  const db = getDb();
  const rows = await db<{ id: string }[]>`
    UPDATE llm_credentials
    SET provider = COALESCE(${params.provider ?? null}, provider),
        proto_type = COALESCE(${params.protoType ?? null}, proto_type),
        base_url = COALESCE(${params.baseUrl ?? null}, base_url),
        model_id = COALESCE(${params.modelId ?? null}, model_id),
        thinking_effort = COALESCE(${params.thinkingEffort ?? null}, thinking_effort),
        label = COALESCE(${params.label ?? null}, label),
        context_window_tokens = COALESCE(${params.contextWindowTokens ?? null}, context_window_tokens)
    WHERE id = ${params.id}
      AND (${params.ctx && shouldFilterByUser(params.ctx) ? params.ctx.userId : null}::uuid IS NULL OR owner_id = ${params.ctx?.userId ?? null})
    RETURNING id
  `;
  return rows.length > 0;
}

export async function upsertCredential(params: {
  id?: string; // if provided, update existing; otherwise create new
  provider: string;
  protoType: string;
  baseUrl?: string;
  modelId: string;
  thinkingEffort?: string;
  label?: string;
  apiKey: string;
  isDefault?: boolean;
  contextWindowTokens?: number;
  ownerId?: string | null;
  ctx?: QueryContext;
}): Promise<string> {
  const db = getDb();
  const vault = params.apiKey ? getVault() : null;
  const encrypted = params.apiKey && vault ? vault.encrypt(params.apiKey) : null;
  const contextWindowTokens = normalizeContextWindowTokens(params.contextWindowTokens);
  const ownerId = params.ctx && shouldFilterByUser(params.ctx) ? params.ctx.userId : (params.ownerId ?? null);

  if (params.id) {
    // Update existing credential
    const rows = await db<{ id: string }[]>`
      UPDATE llm_credentials
      SET provider = ${params.provider}, proto_type = ${params.protoType},
          base_url = ${params.baseUrl ?? null}, model_id = ${params.modelId},
          thinking_effort = ${params.thinkingEffort ?? "off"},
          label = ${params.label ?? ""},
          api_key_ciphertext = ${encrypted?.ciphertext ?? null},
          api_key_iv = ${encrypted?.iv ?? null},
          api_key_tag = ${encrypted?.tag ?? null},
          key_fingerprint = ${vault?.fingerprint() ?? null},
          context_window_tokens = ${contextWindowTokens},
          owner_id = ${ownerId}
      WHERE id = ${params.id}
        AND (${params.ctx && shouldFilterByUser(params.ctx) ? params.ctx.userId : null}::uuid IS NULL OR owner_id = ${params.ctx?.userId ?? null})
      RETURNING id
    `;
    if (rows.length === 0) return "";
    if (params.isDefault) {
      if (params.ctx) await setDefaultCredential(params.ctx, params.id);
      else await setDefaultCredential(params.id);
    }
    return params.id;
  }

  // Create new credential
  const makeDefault = params.isDefault ?? false;
  if (makeDefault) {
    if (params.ctx && shouldFilterByUser(params.ctx)) {
      await db`UPDATE llm_credentials SET is_default = false WHERE owner_id = ${params.ctx.userId}`;
    } else {
      await db`UPDATE llm_credentials SET is_default = false WHERE is_default = true`;
    }
  }

  // If this is the first credential, auto-set as default
  const countRows = await db<{ count: string }[]>`SELECT COUNT(*) as count FROM llm_credentials`;
  const isFirst = Number(countRows[0]?.count ?? 0) === 0;

  const rows = await db<{ id: string }[]>`
    INSERT INTO llm_credentials (
      provider, proto_type, base_url, model_id, thinking_effort, label, is_default, owner_id,
      api_key_ciphertext, api_key_iv, api_key_tag, key_fingerprint, context_window_tokens
    ) VALUES (
      ${params.provider}, ${params.protoType}, ${params.baseUrl ?? null},
      ${params.modelId}, ${params.thinkingEffort ?? "off"}, ${params.label ?? ""},
      ${makeDefault || isFirst}, ${ownerId},
      ${encrypted?.ciphertext ?? null}, ${encrypted?.iv ?? null}, ${encrypted?.tag ?? null}, ${vault?.fingerprint() ?? null}, ${contextWindowTokens}
    )
    RETURNING id
  `;

  return rows[0]?.id ?? "";
}

export async function checkCredentialHealth(): Promise<{
  total: number;
  ok: number;
  failed: number;
  keyUnavailable: boolean;
  currentKeyFingerprint: string | null;
  failedCredentials: Array<{ id: string; label: string; key_fingerprint: string | null }>;
}> {
  const credentials = await listCredentials();
  const failedCredentials = credentials
    .filter((cred) => cred.credential_health === "decrypt_failed")
    .map((cred) => ({ id: cred.id, label: cred.label, key_fingerprint: cred.key_fingerprint }));
  const cryptoStatus = getCredentialCryptoStatus();
  return {
    total: credentials.length,
    ok: credentials.filter((cred) => cred.credential_health === "ok").length,
    failed: failedCredentials.length,
    keyUnavailable: cryptoStatus.state === "key_unavailable",
    currentKeyFingerprint: cryptoStatus.state === "available" ? cryptoStatus.currentKeyFingerprint : null,
    failedCredentials,
  };
}

function normalizeSystemConfig(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const cfg = { ...rawConfig };
  const ceilingMb = deploymentUploadCeilingMb();
  const uploadMb = normalizeSourceArchiveUploadMaxMb(cfg, ceilingMb);
  cfg.source_archive_upload_max_mb = uploadMb;
  cfg.upload_zip_max_mb = uploadMb;
  cfg.upload_gateway_limit_mb = ceilingMb;
  cfg.source_archive_upload_ceiling_mb = ceilingMb;
  cfg.source_archive_effective_max_mb = uploadMb;
  return cfg;
}

export async function getSystemConfig(): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db<{ config: Record<string, unknown> | string }[]>`
    SELECT config FROM system_config WHERE id = 1
  `;
  const raw = rows[0]?.config;
  if (!raw) return normalizeSystemConfig({});
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return normalizeSystemConfig(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
    } catch {
      return normalizeSystemConfig({});
    }
  }
  return normalizeSystemConfig(raw);
}

function validateBoundedInt(key: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** Positive integer, minimum only (no upper bound). */
function validateMinInt(key: string, value: unknown, fallback: number, min: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
  }
  return n;
}

const DERIVED_SYSTEM_CONFIG_KEYS = [
  "upload_gateway_limit_mb",
  "source_archive_upload_ceiling_mb",
  "source_archive_effective_max_mb",
];

export async function updateSystemConfig(patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const current = await getSystemConfig();
  const merged = { ...current, ...patch };
  for (const key of DERIVED_SYSTEM_CONFIG_KEYS) delete merged[key];
  if (patch.upload_zip_max_mb != null && patch.source_archive_upload_max_mb == null) {
    merged.source_archive_upload_max_mb = patch.upload_zip_max_mb;
  }
  const ceilingMb = deploymentUploadCeilingMb();
  merged.max_parallel_scan = validateMinInt("max_parallel_scan", merged.max_parallel_scan, 3, 1);
  merged.tasks_page_size = validateBoundedInt("tasks_page_size", merged.tasks_page_size, 10, 1, 500);
  // youngflow_max_parallel removed from schema (task-level agent_max_parallel).
  // Preserve legacy key in DB if present; do not accept/merge from patch.
  if ("youngflow_max_parallel" in patch) {
    if (Object.prototype.hasOwnProperty.call(current, "youngflow_max_parallel")) {
      merged.youngflow_max_parallel = current.youngflow_max_parallel;
    } else {
      delete merged.youngflow_max_parallel;
    }
  }
  if ("cloudrouter_promo_enabled" in patch) {
    if (typeof patch.cloudrouter_promo_enabled !== "boolean") {
      throw new Error("cloudrouter_promo_enabled must be a boolean");
    }
    merged.cloudrouter_promo_enabled = patch.cloudrouter_promo_enabled;
  }
  merged.source_archive_upload_max_mb = validateBoundedInt("source_archive_upload_max_mb", merged.source_archive_upload_max_mb, Math.min(500, ceilingMb), 1, ceilingMb);
  merged.upload_zip_max_mb = merged.source_archive_upload_max_mb;
  await db`
    UPDATE system_config SET config = ${db.json(merged as never)}::jsonb, updated_at = now()
    WHERE id = 1
  `;
}


/** Update the L4 deep verification status for a credential. */
export async function updateDeepVerifiedStatus(
  credentialId: string,
  status: "pending" | "running" | "passed" | "failed",
): Promise<void> {
  const db = getDb();
  await db`
    UPDATE llm_credentials
    SET deep_verified_status = ${status},
        deep_verified_at = CASE WHEN ${status} IN ('passed', 'failed') THEN now() ELSE deep_verified_at END
    WHERE id = ${credentialId}
  `;
}
