/**
 * Long-lived API token storage for server-to-server integrations.
 *
 * A token is a high-entropy random string `vht_<base64url(32 bytes)>`. Its
 * plaintext is returned exactly once at issue time; the DB only ever holds
 * sha256(rawToken) hex. Because the token is unguessable, a fast hash
 * (SHA-256) is used instead of bcrypt — resolveApiToken runs on every Bearer
 * request and must stay near-zero cost.
 *
 * There is no expiry column: a token lives until revoked (revoked_at set).
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../../infra/db/client.js";
import { logger } from "../../infra/logger.js";
import type { SessionUser } from "./types.js";

const TOKEN_PREFIX = "vht_";

/** sha256(rawToken) hex — the only representation persisted. */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Mint a new token for `userId`. The token is bound to the user's tenant.
 * Returns the row id and the plaintext token — the plaintext is NOT persisted
 * and can never be recovered, so the caller must surface it immediately.
 */
export async function issueApiToken(
  userId: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const db = getDb();
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const rows = await db<{ id: string }[]>`
    INSERT INTO user_api_tokens (tenant_id, user_id, name, token_hash)
    SELECT u.tenant_id, u.id, ${name}, ${tokenHash}
    FROM users u
    WHERE u.id = ${userId}
    RETURNING id
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Cannot issue API token: user ${userId} not found`);
  }
  return { id: row.id, token };
}

/**
 * Resolve a raw Bearer token to its owning user's SessionUser projection.
 *
 * Hot path — fail closed, never throw. Returns null when the token prefix is
 * wrong, the hash is not found, the token is revoked, or the owning user is
 * not active. On a hit, last_used_at is refreshed fire-and-forget (not
 * awaited) so the request is not blocked on a write.
 *
 * The projection mirrors auth/service.ts::resolveSession, except sessionId is
 * a synthetic marker "apitoken:<tokenId>" that can never collide with a real
 * session id — session/logout flows only ever touch the sessions table, so a
 * token identity is untouched by them.
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
        AND u.status = 'active'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;

    // Fire-and-forget last_used_at bump; must not block or fail the request.
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

/** Revoke a token by id (idempotent — sets revoked_at). */
export async function revokeApiToken(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE user_api_tokens SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL
  `;
}
