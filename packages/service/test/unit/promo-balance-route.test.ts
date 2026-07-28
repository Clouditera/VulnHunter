import { beforeEach, describe, expect, it, vi } from "vitest";

let balancePayload: Record<string, unknown> = { available: false };

vi.mock("../../src/features/promo/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/features/promo/storage.js")>();
  return {
    ...actual,
    isCloudrouterPromoEnabled: async () => true,
    getMyCreditCode: async () => null,
    hasAvailableCreditCode: async () => false,
    claimCreditCode: async () => ({ kind: "pool_empty" }),
    getCloudrouterBalance: async () => balancePayload,
  };
});

vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { userId: "user-1", email: "u@x.com", role: "member", tenantId: "t1" });
    return next();
  },
}));

const { promoRouter } = await import("../../src/features/promo/routes.js");

describe("GET /cloudrouter/balance route", () => {
  beforeEach(() => {
    balancePayload = { available: false };
  });

  it("returns 200 business state when unavailable", async () => {
    const res = await promoRouter.request("/cloudrouter/balance", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("returns 200 with balance payload", async () => {
    balancePayload = {
      available: true,
      remaining: 10,
      unit: "USD",
      planName: "钱包余额",
      mode: "unrestricted",
      updated_at: "2026-07-28T00:00:00.000Z",
    };
    const res = await promoRouter.request("/cloudrouter/balance", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ available: true, remaining: 10, unit: "USD" });
  });
});
