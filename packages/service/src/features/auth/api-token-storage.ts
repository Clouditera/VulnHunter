/**
 * Long-lived API token storage for server-to-server integrations + user self-service.
 *
 * A token is a high-entropy random string `vht_<base64url(32 bytes)>`. Its
 * plaintext is returned exactly once at issue time; the DB only ever holds
 * sha256(rawToken) hex. Because the token is unguessable, a fast hash
 * (SHA-256) is used instead of bcrypt — resolveApiToken runs on every Bearer
 * request and must stay near-zero cost.
 *
 * Invalidation: revoked_at set, OR expires_at in the past, OR owning user not active.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../../infra/db/client.js";
import { logger } from "../../infra/logger.js";
import type { SessionUser } from "./types.js";

const TOKEN_PREFIX = "vht_";
/** Max non-revoked tokens per user (active + expired still count until revoked). */
export const API_TOKEN_LIMIT = 10;

/** Allowed expiry presets from the settings UI (null = permanent). */
export const API_TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;

export type ApiTokenStatus = "active" | "expired" | "revoked";

export interface ApiTokenRow {
  id: string;
  name: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface ApiTokenView {
  id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  status: ApiTokenStatus;
}

/** sha256(rawToken) hex — the only representation persisted. */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

export function computeTokenStatus(row: {
  revoked_at: Date | string | null;
  expires_at: Date | string | null;
  now?: Date;
}): ApiTokenStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at) {
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    const now = row.now ?? new Date();
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) return "expired";
  }
  return "active";
}

function toView(row: ApiTokenRow): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    created_at: toIso(row.created_at) ?? new Date(0).toISOString(),
    expires_at: toIso(row.expires_at),
    last_used_at: toIso(row.last_used_at),
    revoked_at: toIso(row.revoked_at),
    status: computeTokenStatus(row),
  };
}

/**
 * Mint a new token for `userId`. The token is bound to the user's tenant.
 * Returns the row id and the plaintext token — the plaintext is NOT persisted
 * and can never be recovered, so the caller must surface it immediately.
 *
 * @param expiresInDays null = permanent; otherwise days from now (must be > 0).
 */
export async function issueApiToken(
  userId: string,
  name: string,
  expiresInDays: number | null = null,
): Promise<{ id: string; token: string; view: ApiTokenView }> {
  const db = getDb();
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const trimmed = name.trim();
  if (!trimmed) {
    throw Object.assign(new Error("name required"), { code: "ERR_API_TOKEN_NAME_REQUIRED" });
  }

  // Enforce per-user non-revoked limit.
  const countRows = await db<{ n: string }[]>`
    SELECT count(*)::text AS n FROM user_api_tokens
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
  const n = Number(countRows[0]?.n ?? 0);
  if (n >= API_TOKEN_LIMIT) {
    throw Object.assign(new Error("token limit"), { code: "ERR_API_TOKEN_LIMIT" });
  }

  let expiresAt: Date | null = null;
  if (expiresInDays != null) {
    if (!Number.isFinite(expiresInDays) || expiresInDays <= 0) {
      throw Object.assign(new Error("invalid expires_in_days"), { code: "ERR_API_TOKEN_NAME_REQUIRED" });
    }
    expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  }

  const rows = await db<ApiTokenRow[]>`
    INSERT INTO user_api_tokens (tenant_id, user_id, name, token_hash, expires_at)
    SELECT u.tenant_id, u.id, ${trimmed}, ${tokenHash}, ${expiresAt}
    FROM users u
    WHERE u.id = ${userId}
    RETURNING id, name, created_at, expires_at, last_used_at, revoked_at
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Cannot issue API token: user ${userId} not found`);
  }
  return { id: row.id, token, view: toView(row) };
}

/** List all tokens for a user (including revoked/expired), newest first. */
export async function listApiTokens(userId: string): Promise<{ tokens: ApiTokenView[]; limit: number; count: number }> {
  const db = getDb();
  const rows = await db<ApiTokenRow[]>`
    SELECT id, name, created_at, expires_at, last_used_at, revoked_at
    FROM user_api_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  const tokens = rows.map(toView);
  const count = tokens.filter((t) => t.revoked_at == null).length;
  return { tokens, limit: API_TOKEN_LIMIT, count };
}

/** Rename a token owned by userId. */
export async function renameApiToken(userId: string, id: string, name: string): Promise<ApiTokenView> {
  const db = getDb();
  const trimmed = name.trim();
  if (!trimmed) {
    throw Object.assign(new Error("name required"), { code: "ERR_API_TOKEN_NAME_REQUIRED" });
  }
  const rows = await db<ApiTokenRow[]>`
    UPDATE user_api_tokens
    SET name = ${trimmed}
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, name, created_at, expires_at, last_used_at, revoked_at
  `;
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error("not found"), { code: "ERR_API_TOKEN_NOT_FOUND" });
  }
  return toView(row);
}

/** Revoke a token owned by userId (idempotent). */
export async function revokeApiTokenForUser(userId: string, id: string): Promise<ApiTokenView> {
  const db = getDb();
  const rows = await db<ApiTokenRow[]>`
    UPDATE user_api_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, name, created_at, expires_at, last_used_at, revoked_at
  `;
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error("not found"), { code: "ERR_API_TOKEN_NOT_FOUND" });
  }
  return toView(row);
}

/**
 * @deprecated Prefer revokeApiTokenForUser (scoped). Kept for tests/CLI cleanup.
 * Revoke a token by id without owner check (idempotent).
 */
export async function revokeApiToken(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE user_api_tokens SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL
  `;
}

/**
 * Resolve a raw Bearer token to its owning user's SessionUser projection.
 *
 * Hot path — fail closed, never throw. Returns null when the token prefix is
 * wrong, the hash is not found, the token is revoked/expired, or the owning
 * user is not active. On a hit, last_used_at is refreshed fire-and-forget.
 */
export async function resolveApiToken(rawToken: string): Promise<SessionUser | null> {
  if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
  try {
    const db = getDb();
    const tokenHash = hashToken(rawToken);
    const rows = await db<
      {
        token_id: string;
        user_id: string;
        tenant_id: string;
        email: string;
        role: string;
        display_name: string;
      }[]
    >`
      SELECT t.id AS token_id, u.id AS user_id, u.tenant_id, u.email, u.role, u.display_name
      FROM user_api_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
        AND u.status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    void db`
      UPDATE user_api_tokens SET last_used_at = now() WHERE id = ${row.token_id}
    `.catch((err) => {
      logger.warn({ err, tokenId: row.token_id }, "Failed to update API token last_used_at");
    });

    return {
      userId: row.user_id,
      tenantId: row.tenant_id,
      email: row.email,
      role: row.role as "admin" | "member",
      displayName: row.display_name,
      sessionId: `apitoken:${row.token_id}`,
    };
  } catch (err) {
    logger.warn({ err }, "resolveApiToken failed; treating as unauthenticated");
    return null;
  }
}
