import { createHash, randomInt, randomBytes } from "node:crypto";
import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 60_000;
const EMAIL_PER_DAY = 10;
const IP_PER_DAY = 30;

export type CodePurpose = "register" | "reset";

export interface EmailCodeRow {
  id: string;
  email: string;
  purpose: CodePurpose;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  created_at: Date;
}

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/** Salt is embedded in the stored hash as salt$hex */
export function makeCodeHash(code: string): string {
  const salt = randomBytes(8).toString("hex");
  return `${salt}$${hashCode(code, salt)}`;
}

export function verifyCodeHash(code: string, stored: string): boolean {
  const [salt, hex] = stored.split("$");
  if (!salt || !hex) return false;
  return hashCode(code, salt) === hex;
}

export function generateNumericCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function countRecentByEmail(email: string, purpose: CodePurpose, windowMs: number): Promise<number> {
  const db = getDb();
  const since = new Date(Date.now() - windowMs);
  const rows = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM email_verification_codes
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
      AND lower(email) = ${email.toLowerCase()}
      AND purpose = ${purpose}
      AND created_at >= ${since}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function countRecentByIpMarker(ipMarker: string, windowMs: number): Promise<number> {
  // IP is not a column; we encode it into a synthetic email-side channel via purpose+prefix is awkward.
  // Contract wants IP rate limit: store ip in a dedicated table is overkill — use system-side map in service layer.
  void ipMarker;
  void windowMs;
  return 0;
}

export async function getActiveCode(email: string, purpose: CodePurpose): Promise<EmailCodeRow | null> {
  const db = getDb();
  const rows = await db<EmailCodeRow[]>`
    SELECT id, email, purpose, code_hash, expires_at, attempts, consumed_at, created_at
    FROM email_verification_codes
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
      AND lower(email) = ${email.toLowerCase()}
      AND purpose = ${purpose}
      AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function invalidateActiveCodes(email: string, purpose: CodePurpose): Promise<void> {
  const db = getDb();
  await db`
    UPDATE email_verification_codes
    SET consumed_at = now()
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
      AND lower(email) = ${email.toLowerCase()}
      AND purpose = ${purpose}
      AND consumed_at IS NULL
  `;
}

export async function insertCode(email: string, purpose: CodePurpose, code: string): Promise<{ expiresAt: Date; cooldownSeconds: number }> {
  await invalidateActiveCodes(email, purpose);
  const db = getDb();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const codeHash = makeCodeHash(code);
  await db`
    INSERT INTO email_verification_codes (tenant_id, email, purpose, code_hash, expires_at)
    VALUES (${DEFAULT_TENANT_ID}, ${email.toLowerCase()}, ${purpose}, ${codeHash}, ${expiresAt})
  `;
  return { expiresAt, cooldownSeconds: Math.floor(COOLDOWN_MS / 1000) };
}

export type VerifyFail =
  | "invalid_code"
  | "code_expired"
  | "attempts_exceeded"
  | "no_code";

export async function verifyAndConsume(
  email: string,
  purpose: CodePurpose,
  code: string,
): Promise<{ ok: true } | { ok: false; error: VerifyFail }> {
  const active = await getActiveCode(email, purpose);
  if (!active) return { ok: false, error: "no_code" };
  if (active.attempts >= MAX_ATTEMPTS) return { ok: false, error: "attempts_exceeded" };
  if (new Date(active.expires_at).getTime() <= Date.now()) {
    await bumpAttempts(active.id);
    return { ok: false, error: "code_expired" };
  }
  if (!verifyCodeHash(code, active.code_hash)) {
    const attempts = await bumpAttempts(active.id);
    if (attempts >= MAX_ATTEMPTS) return { ok: false, error: "attempts_exceeded" };
    return { ok: false, error: "invalid_code" };
  }
  const db = getDb();
  await db`
    UPDATE email_verification_codes SET consumed_at = now() WHERE id = ${active.id}
  `;
  return { ok: true };
}

async function bumpAttempts(id: string): Promise<number> {
  const db = getDb();
  const rows = await db<{ attempts: number }[]>`
    UPDATE email_verification_codes
    SET attempts = attempts + 1
    WHERE id = ${id}
    RETURNING attempts
  `;
  return rows[0]?.attempts ?? 0;
}

export async function secondsSinceLastCode(email: string, purpose: CodePurpose): Promise<number | null> {
  const active = await getActiveCode(email, purpose);
  if (!active) return null;
  const ageMs = Date.now() - new Date(active.created_at).getTime();
  return Math.floor(ageMs / 1000);
}

export const RATE = {
  COOLDOWN_MS,
  EMAIL_PER_DAY,
  IP_PER_DAY,
  MAX_ATTEMPTS,
  CODE_TTL_MS,
};
