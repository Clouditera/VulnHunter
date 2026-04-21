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
  const row = rows[0];

  const apiKey = getVault().decrypt({
    ciphertext: row.api_key_ciphertext,
    iv: row.api_key_iv,
    tag: row.api_key_tag,
  });

  return { ...row, api_key: apiKey };
}

export async function upsertCredential(params: {
  provider: string;
  protoType: string;
  baseUrl?: string;
  modelId: string;
  thinkingEffort?: string;
  label?: string;
  apiKey: string;
}): Promise<string> {
  const db = getDb();
  const vault = getVault();

  const encrypted = vault.encrypt(params.apiKey);

  const rows = await db<{ id: string }[]>`
    INSERT INTO llm_credentials (
      provider, proto_type, base_url, model_id, thinking_effort, label, is_default,
      api_key_ciphertext, api_key_iv, api_key_tag
    ) VALUES (
      ${params.provider}, ${params.protoType}, ${params.baseUrl ?? null},
      ${params.modelId}, ${params.thinkingEffort ?? "off"}, ${params.label ?? ""},
      true,
      ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.tag}
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;

  if (!rows[0]) {
    // Update existing
    const existing = await db<{ id: string }[]>`SELECT id FROM llm_credentials LIMIT 1`;
    if (existing[0]) {
      await db`
        UPDATE llm_credentials
        SET provider = ${params.provider}, proto_type = ${params.protoType},
            base_url = ${params.baseUrl ?? null}, model_id = ${params.modelId},
            thinking_effort = ${params.thinkingEffort ?? "off"},
            label = ${params.label ?? ""},
            api_key_ciphertext = ${encrypted.ciphertext},
            api_key_iv = ${encrypted.iv},
            api_key_tag = ${encrypted.tag}
        WHERE id = ${existing[0].id}
      `;
      return existing[0].id;
    }
  }

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
