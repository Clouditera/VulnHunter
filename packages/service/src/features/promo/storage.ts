/**
 * CloudRouter promo: inventory lookup + atomic claim (DB-level idempotency).
 */

import { getDb } from "../../infra/db/client.js";
import { getSystemConfig } from "../settings/storage.js";

export async function isCloudrouterPromoEnabled(): Promise<boolean> {
  const cfg = await getSystemConfig();
  return cfg.cloudrouter_promo_enabled !== false;
}

export async function getMyCreditCode(userId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db<{ code: string }[]>`
    SELECT code FROM credit_codes
    WHERE assigned_user_id = ${userId}
    LIMIT 1
  `;
  return rows[0]?.code ?? null;
}

export async function hasAvailableCreditCode(): Promise<boolean> {
  const db = getDb();
  const rows = await db<{ ok: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM credit_codes WHERE status = 'available'
    ) AS ok
  `;
  return Boolean(rows[0]?.ok);
}

export type ClaimResult =
  | { kind: "claimed"; code: string; already_claimed: boolean }
  | { kind: "pool_empty" };

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

/**
 * Atomic claim:
 * 1. already assigned → same code, already_claimed
 * 2. SKIP LOCKED take one available → claimed
 * 3. 23505 race → re-read own code
 * 4. none left → pool_empty
 */
export async function claimCreditCode(userId: string): Promise<ClaimResult> {
  const existing = await getMyCreditCode(userId);
  if (existing) {
    return { kind: "claimed", code: existing, already_claimed: true };
  }

  const db = getDb();
  try {
    const rows = await db<{ code: string }[]>`
      UPDATE credit_codes
      SET status = 'assigned', assigned_user_id = ${userId}, assigned_at = now()
      WHERE id = (
        SELECT id FROM credit_codes
        WHERE status = 'available'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING code
    `;
    if (rows[0]?.code) {
      return { kind: "claimed", code: rows[0].code, already_claimed: false };
    }
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await getMyCreditCode(userId);
      if (again) {
        return { kind: "claimed", code: again, already_claimed: true };
      }
    }
    throw err;
  }

  // No row updated — either pool empty or lost race; re-check own code then empty
  const after = await getMyCreditCode(userId);
  if (after) {
    return { kind: "claimed", code: after, already_claimed: true };
  }
  return { kind: "pool_empty" };
}
