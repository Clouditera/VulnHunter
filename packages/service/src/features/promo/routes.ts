/**
 * CloudRouter user-facing promo endpoints.
 * GET  /api/promo/cloudrouter
 * POST /api/promo/cloudrouter/claim
 */

import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as promoStorage from "./storage.js";

export const promoRouter = new Hono();
promoRouter.use("*", licenseGuard);
promoRouter.use("*", requireAuth);

// ── per-user claim rate limit: 10 / minute sliding window ──
const CLAIM_WINDOW_MS = 60_000;
const CLAIM_MAX = 10;
const claimHits = new Map<string, number[]>();

/** Exported for unit tests. */
export function _resetClaimRateLimitForTests(): void {
  claimHits.clear();
}

function checkClaimRate(userId: string): { ok: true } | { ok: false; retry_after_seconds: number } {
  const now = Date.now();
  const prev = (claimHits.get(userId) ?? []).filter((t) => now - t < CLAIM_WINDOW_MS);
  if (prev.length >= CLAIM_MAX) {
    const retryAfter = Math.max(1, Math.ceil((prev[0]! + CLAIM_WINDOW_MS - now) / 1000));
    claimHits.set(userId, prev);
    return { ok: false, retry_after_seconds: retryAfter };
  }
  prev.push(now);
  claimHits.set(userId, prev);
  return { ok: true };
}

// GET /api/promo/cloudrouter
promoRouter.get("/cloudrouter", async (c) => {
  const user = c.get("user");
  const [enabled, my_code, available] = await Promise.all([
    promoStorage.isCloudrouterPromoEnabled(),
    promoStorage.getMyCreditCode(user.userId),
    promoStorage.hasAvailableCreditCode(),
  ]);
  return c.json({ enabled, my_code, available });
});

// POST /api/promo/cloudrouter/claim
promoRouter.post("/cloudrouter/claim", async (c) => {
  const user = c.get("user");

  const rate = checkClaimRate(user.userId);
  if (!rate.ok) {
    return c.json(
      { error: { code: "rate_limited", retry_after_seconds: rate.retry_after_seconds } },
      429,
    );
  }

  const enabled = await promoStorage.isCloudrouterPromoEnabled();
  if (!enabled) {
    return c.json({ error: { code: "ERR_PROMO_DISABLED" } }, 403);
  }

  const result = await promoStorage.claimCreditCode(user.userId);
  if (result.kind === "pool_empty") {
    return c.json({ ok: true, code: null, pool_empty: true });
  }
  return c.json({
    ok: true,
    code: result.code,
    already_claimed: result.already_claimed,
  });
});
