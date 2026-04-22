import { getDb } from "../../infra/db/client.js";
import { MasterKeyVault } from "../../infra/crypto/master-key-vault.js";

let _vault: MasterKeyVault | null = null;

export function initVault(dataDir: string): void {
  _vault = new MasterKeyVault(dataDir);
}

function getVault(): MasterKeyVault {
  if (!_vault) throw new Error("Vault not initialized");
  return _vault;
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
           api_key_ciphertext, api_key_iv, api_key_tag
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
           api_key_ciphertext, api_key_iv, api_key_tag
    FROM llm_credentials
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  return decryptRow(rows[0]);
}

export async function listCredentials(): Promise<DbLlmCredential[]> {
  const db = getDb();
  return db<DbLlmCredential[]>`
    SELECT id, provider, proto_type, base_url, model_id, thinking_effort, label, is_default
    FROM llm_credentials
    ORDER BY is_default DESC, created_at DESC
  `;
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
          api_key_tag = ${encrypted.tag}
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
      api_key_ciphertext, api_key_iv, api_key_tag
    ) VALUES (
      ${params.provider}, ${params.protoType}, ${params.baseUrl ?? null},
      ${params.modelId}, ${params.thinkingEffort ?? "off"}, ${params.label ?? ""},
      ${makeDefault || isFirst},
      ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.tag}
    )
    RETURNING id
  `;

  return rows[0]?.id ?? "";
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
