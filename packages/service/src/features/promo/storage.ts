/**
 * CloudRouter promo: inventory lookup + atomic claim (DB-level idempotency)
 * + balance proxy (GET /v1/usage via user credential).
 */

import { getDb } from "../../infra/db/client.js";
import { getSystemConfig, getDefaultCredential, listCredentials, getCredentialById } from "../settings/storage.js";
import type { QueryContext } from "../../infra/query-context.js";

const BALANCE_CACHE_TTL_MS = 60_000;
const BALANCE_FETCH_TIMEOUT_MS = 5_000;

export type BalanceUnavailable = { available: false };
export type BalanceAvailable = {
  available: true;
  remaining: number | null;
  unit: string | null;
  planName: string | null;
  mode: string | null;
  updated_at: string;
};
export type BalanceResult = BalanceUnavailable | BalanceAvailable;

type CacheEntry = { expiresAt: number; value: BalanceResult };
const balanceCache = new Map<string, CacheEntry>();

/** Test hook. */
export function _resetBalanceCacheForTests(): void {
  balanceCache.clear();
}

export function isCloudrouterBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "cloudrouter.online" || host.endsWith(".cloudrouter.online");
  } catch {
    return /cloudrouter\.online/i.test(baseUrl);
  }
}

/** Build usage URL from credential base_url (…/v1 or bare host). */
export function cloudrouterUsageUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/$/, "");
  if (/\/v1$/i.test(b)) return `${b}/usage`;
  return `${b}/v1/usage`;
}

/**
 * Prefer user's default credential when it is CloudRouter; else first owned
 * CloudRouter credential (so balance still works if default is another provider).
 */
export async function findCloudrouterCredentialForUser(ctx: QueryContext): Promise<{
  id: string;
  base_url: string;
  api_key: string;
} | null> {
  const def = await getDefaultCredential(ctx);
  if (def?.api_key && isCloudrouterBaseUrl(def.base_url)) {
    return { id: def.id, base_url: def.base_url!, api_key: def.api_key };
  }

  const listed = await listCredentials(ctx);
  for (const row of listed) {
    if (!isCloudrouterBaseUrl(row.base_url)) continue;
    // Prefer personal over global when both match
    if (row.scope === "personal" || row.can_edit) {
      try {
        const full = await getCredentialById(ctx, row.id);
        if (full?.api_key && full.base_url) {
          return { id: full.id, base_url: full.base_url, api_key: full.api_key };
        }
      } catch {
        continue;
      }
    }
  }
  // Last resort: any listed cloudrouter (e.g. global) if decryptable
  for (const row of listed) {
    if (!isCloudrouterBaseUrl(row.base_url)) continue;
    try {
      const full = await getCredentialById(ctx, row.id);
      if (full?.api_key && full.base_url) {
        return { id: full.id, base_url: full.base_url, api_key: full.api_key };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export type FetchUsageFn = (url: string, apiKey: string, timeoutMs: number) => Promise<{
  ok: boolean;
  status: number;
  json: unknown;
}>;

export const defaultFetchUsage: FetchUsageFn = async (url, apiKey, timeoutMs) => {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
};

function parseUsageBody(json: unknown): Omit<BalanceAvailable, "available" | "updated_at"> | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const remaining =
    typeof o.remaining === "number" && Number.isFinite(o.remaining)
      ? o.remaining
      : typeof o.balance === "number" && Number.isFinite(o.balance)
        ? o.balance
        : null;
  // Successful parse even when remaining is 0 / null-ish but body is valid usage payload
  if (!("remaining" in o || "balance" in o || "usage" in o || "isValid" in o)) {
    return null;
  }
  return {
    remaining,
    unit: typeof o.unit === "string" ? o.unit : null,
    planName: typeof o.planName === "string" ? o.planName : null,
    mode: typeof o.mode === "string" ? o.mode : null,
  };
}

/**
 * Resolve CloudRouter balance for user. Always resolves (never throws for upstream errors).
 * Cache key = userId, TTL 60s. fetchImpl injectable for tests.
 */
export async function getCloudrouterBalance(
  ctx: QueryContext,
  opts?: { fetchImpl?: FetchUsageFn; now?: number; skipCache?: boolean },
): Promise<BalanceResult> {
  const now = opts?.now ?? Date.now();
  const cacheKey = ctx.userId;
  if (!opts?.skipCache) {
    const hit = balanceCache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.value;
  }

  const unavailable = (): BalanceUnavailable => ({ available: false });

  let cred: { id: string; base_url: string; api_key: string } | null;
  try {
    cred = await findCloudrouterCredentialForUser(ctx);
  } catch {
    const value = unavailable();
    balanceCache.set(cacheKey, { expiresAt: now + BALANCE_CACHE_TTL_MS, value });
    return value;
  }

  if (!cred) {
    const value = unavailable();
    balanceCache.set(cacheKey, { expiresAt: now + BALANCE_CACHE_TTL_MS, value });
    return value;
  }

  const fetchImpl = opts?.fetchImpl ?? defaultFetchUsage;
  const url = cloudrouterUsageUrl(cred.base_url);
  try {
    const res = await fetchImpl(url, cred.api_key, BALANCE_FETCH_TIMEOUT_MS);
    if (!res.ok) {
      const value = unavailable();
      balanceCache.set(cacheKey, { expiresAt: now + BALANCE_CACHE_TTL_MS, value });
      return value;
    }
    const parsed = parseUsageBody(res.json);
    if (!parsed) {
      const value = unavailable();
      balanceCache.set(cacheKey, { expiresAt: now + BALANCE_CACHE_TTL_MS, value });
      return value;
    }
    const value: BalanceAvailable = {
      available: true,
      ...parsed,
      updated_at: new Date(now).toISOString(),
    };
    balanceCache.set(cacheKey, { expiresAt: now + BALANCE_CACHE_TTL_MS, value });
    return value;
  } catch {
    // timeout / network
    const value = unavailable();
    balanceCache.set(cacheKey, { expiresAt: now + BALANCE_CACHE_TTL_MS, value });
    return value;
  }
}

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
