import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  enabled: true,
  myCode: null as string | null,
  available: true,
  claim: { kind: "claimed" as const, code: "CR-1", already_claimed: false },
};

vi.mock("../../src/features/promo/storage.js", () => ({
  isCloudrouterPromoEnabled: async () => state.enabled,
  getMyCreditCode: async () => state.myCode,
  hasAvailableCreditCode: async () => state.available,
  claimCreditCode: async () => state.claim,
}));

vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { userId: "user-1", email: "u@x.com", role: "member" });
    return next();
  },
}));

const { promoRouter, _resetClaimRateLimitForTests } = await import("../../src/features/promo/routes.js");

async function req(method: string, path: string) {
  const res = await promoRouter.request(path, { method });
  const body = await res.json();
  return { status: res.status, body };
}

describe("promo routes", () => {
  beforeEach(() => {
    _resetClaimRateLimitForTests();
    state.enabled = true;
    state.myCode = null;
    state.available = true;
    state.claim = { kind: "claimed", code: "CR-1", already_claimed: false };
  });

  it("GET returns enabled/my_code/available", async () => {
    state.myCode = "CR-MINE";
    state.available = false;
    const res = await req("GET", "/cloudrouter");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, my_code: "CR-MINE", available: false });
  });

  it("claim success", async () => {
    const res = await req("POST", "/cloudrouter/claim");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, code: "CR-1", already_claimed: false });
  });

  it("claim pool_empty is 200 business state", async () => {
    state.claim = { kind: "pool_empty" } as never;
    const res = await req("POST", "/cloudrouter/claim");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, code: null, pool_empty: true });
  });

  it("claim when disabled → 403 ERR_PROMO_DISABLED", async () => {
    state.enabled = false;
    const res = await req("POST", "/cloudrouter/claim");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: "ERR_PROMO_DISABLED" } });
  });

  it("claim rate limit → 429 after 10 hits", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await req("POST", "/cloudrouter/claim");
      expect(r.status).toBe(200);
    }
    const limited = await req("POST", "/cloudrouter/claim");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(limited.body.error.retry_after_seconds).toBeGreaterThan(0);
  });
});
