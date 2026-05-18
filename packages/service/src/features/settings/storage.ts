import { getDb } from "../../infra/db/client.js";
import { MasterKeyVault, CredentialDecryptError, CredentialKeyUnavailableError } from "../../infra/crypto/master-key-vault.js";
import { join } from "node:path";

let _vault: MasterKeyVault | null = null;
let _vaultUnavailableReason: string | null = null;

export function initVault(dataDir: string): void {
  const keyPath = process.env.VULNHUNT_MASTER_KEY_FILE
    ?? (process.env.VULNHUNT_ALLOW_DATA_DIR_MASTER_KEY_FALLBACK === "1" ? join(dataDir, ".master.key") : undefined);
  if (!keyPath) {
    _vault = null;
    _vaultUnavailableReason = "VULNHUNT_MASTER_KEY_FILE is not configured";
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
      "凭证加密 key 未配置。请管理员设置 VULNHUNT_MASTER_KEY_FILE 并重启服务，或挂载正确的 master key 文件。",
    );
  }
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
}

export interface DecryptedLlmCredential extends DbLlmCredential {
  api_key: string;
}

export async function getDefaultCredential(): Promise<DecryptedLlmCredential | null> {
  const db = getDb();
  const rows = await db<(DbLlmCredential & {
    api_key_ciphertext: Buffer;
    api_key_iv: Buffer;
    api_key_tag: Buffer;
  })[]>`
    SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
           key_fingerprint, api_key_ciphertext, api_key_iv, api_key_tag
    FROM llm_credentials
    WHERE is_default = true
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (!rows[0]) return null;
  return decryptRow(rows[0]);
}

export async function getCredentialById(id: string): Promise<DecryptedLlmCredential | null> {
  const db = getDb();
  const rows = await db<(DbLlmCredential & {
    api_key_ciphertext: Buffer;
    api_key_iv: Buffer;
    api_key_tag: Buffer;
  })[]>`
    SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
           key_fingerprint, api_key_ciphertext, api_key_iv, api_key_tag
    FROM llm_credentials
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return decryptRow(rows[0]);
}

export async function getDefaultOrFirstAvailableCredential(): Promise<DecryptedLlmCredential | null> {
  const defaultCredential = await getDefaultCredential();
  if (defaultCredential) return defaultCredential;

  const db = getDb();
  const rows = await db<(DbLlmCredential & {
    api_key_ciphertext: Buffer;
    api_key_iv: Buffer;
    api_key_tag: Buffer;
  })[]>`
    SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
           key_fingerprint, api_key_ciphertext, api_key_iv, api_key_tag
    FROM llm_credentials
    ORDER BY is_default DESC, created_at DESC
  `;

  for (const row of rows) {
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
}

export async function listCredentials(): Promise<ListedLlmCredential[]> {
  const db = getDb();
  const rows = await db<(DbLlmCredential & {
    api_key_ciphertext: Buffer;
    api_key_iv: Buffer;
    api_key_tag: Buffer;
  })[]>`
    SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
           key_fingerprint, api_key_ciphertext, api_key_iv, api_key_tag
    FROM llm_credentials
    ORDER BY is_default DESC, created_at DESC
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
        masked_key: "key 未配置",
        credential_health: "key_unavailable",
        current_key_fingerprint: currentKeyFingerprint,
      } as ListedLlmCredential;
    }

    const vault = getVault();
    let masked = "••••••••";
    let health: ListedLlmCredential["credential_health"] = "unknown";
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
      masked_key: masked,
      credential_health: health,
      current_key_fingerprint: currentKeyFingerprint,
    };
  });
}

export async function deleteCredential(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db`DELETE FROM llm_credentials WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function setDefaultCredential(id: string): Promise<void> {
  const db = getDb();
  await db`UPDATE llm_credentials SET is_default = false WHERE is_default = true`;
  await db`UPDATE llm_credentials SET is_default = true WHERE id = ${id}`;
}

function decryptRow(row: DbLlmCredential & {
  api_key_ciphertext: Buffer;
  api_key_iv: Buffer;
  api_key_tag: Buffer;
}): DecryptedLlmCredential {
  const apiKey = getVault().decrypt({
    ciphertext: row.api_key_ciphertext,
    iv: row.api_key_iv,
    tag: row.api_key_tag,
  });
  return { ...row, api_key: apiKey };
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
}): Promise<void> {
  const db = getDb();
  await db`
    UPDATE llm_credentials
    SET provider = COALESCE(${params.provider ?? null}, provider),
        proto_type = COALESCE(${params.protoType ?? null}, proto_type),
        base_url = COALESCE(${params.baseUrl ?? null}, base_url),
        model_id = COALESCE(${params.modelId ?? null}, model_id),
        thinking_effort = COALESCE(${params.thinkingEffort ?? null}, thinking_effort),
        label = COALESCE(${params.label ?? null}, label)
    WHERE id = ${params.id}
  `;
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
}): Promise<string> {
  const db = getDb();
  const vault = getVault();
  const encrypted = vault.encrypt(params.apiKey);

  if (params.id) {
    // Update existing credential
    await db`
      UPDATE llm_credentials
      SET provider = ${params.provider}, proto_type = ${params.protoType},
          base_url = ${params.baseUrl ?? null}, model_id = ${params.modelId},
          thinking_effort = ${params.thinkingEffort ?? "off"},
          label = ${params.label ?? ""},
          api_key_ciphertext = ${encrypted.ciphertext},
          api_key_iv = ${encrypted.iv},
          api_key_tag = ${encrypted.tag},
          key_fingerprint = ${vault.fingerprint()}
      WHERE id = ${params.id}
    `;
    if (params.isDefault) await setDefaultCredential(params.id);
    return params.id;
  }

  // Create new credential
  const makeDefault = params.isDefault ?? false;
  if (makeDefault) {
    await db`UPDATE llm_credentials SET is_default = false WHERE is_default = true`;
  }

  // If this is the first credential, auto-set as default
  const countRows = await db<{ count: string }[]>`SELECT COUNT(*) as count FROM llm_credentials`;
  const isFirst = Number(countRows[0]?.count ?? 0) === 0;

  const rows = await db<{ id: string }[]>`
    INSERT INTO llm_credentials (
      provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
      api_key_ciphertext, api_key_iv, api_key_tag, key_fingerprint
    ) VALUES (
      ${params.provider}, ${params.protoType}, ${params.baseUrl ?? null},
      ${params.modelId}, ${params.thinkingEffort ?? "off"}, ${params.label ?? ""},
      ${makeDefault || isFirst},
      ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.tag}, ${vault.fingerprint()}
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

export async function getSystemConfig(): Promise<Record<string, unknown>> {
  const db = getDb();
  const rows = await db<{ config: Record<string, unknown> }[]>`
    SELECT config FROM system_config WHERE id = 1
  `;
  return rows[0]?.config ?? {};
}

export async function updateSystemConfig(patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const current = await getSystemConfig();
  const merged = { ...current, ...patch };
  await db`
    UPDATE system_config SET config = ${JSON.stringify(merged)}, updated_at = now()
    WHERE id = 1
  `;
}
