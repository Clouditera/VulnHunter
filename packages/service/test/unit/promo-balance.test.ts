import { beforeEach, describe, expect, it, vi } from "vitest";

const credState = {
  default: null as null | {
    id: string;
    base_url: string | null;
    api_key: string;
    owner_id?: string | null;
  },
  listed: [] as Array<{
    id: string;
    base_url: string | null;
    scope: "personal" | "global";
    can_edit: boolean;
  }>,
  byId: new Map<string, { id: string; base_url: string | null; api_key: string }>(),
};

vi.mock("../../src/features/settings/storage.js", () => ({
  getSystemConfig: async () => ({}),
  getDefaultCredential: async () => credState.default,
  listCredentials: async () => credState.listed,
  getCredentialById: async (_ctx: unknown, id: string) => credState.byId.get(id) ?? null,
}));

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () => Object.assign(async () => [], { json: (v: unknown) => v }),
}));

const storage = await import("../../src/features/promo/storage.js");

const ctx = { tenantId: "t1", userId: "user-1", role: "member" as const };

describe("cloudrouter balance helpers", () => {
  it("isCloudrouterBaseUrl", () => {
    expect(storage.isCloudrouterBaseUrl("https://console.cloudrouter.online/v1")).toBe(true);
    expect(storage.isCloudrouterBaseUrl("https://api.cloudrouter.online")).toBe(true);
    expect(storage.isCloudrouterBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(storage.isCloudrouterBaseUrl(null)).toBe(false);
  });

  it("cloudrouterUsageUrl", () => {
    expect(storage.cloudrouterUsageUrl("https://console.cloudrouter.online/v1")).toBe(
      "https://console.cloudrouter.online/v1/usage",
    );
    expect(storage.cloudrouterUsageUrl("https://console.cloudrouter.online/v1/")).toBe(
      "https://console.cloudrouter.online/v1/usage",
    );
    expect(storage.cloudrouterUsageUrl("https://console.cloudrouter.online")).toBe(
      "https://console.cloudrouter.online/v1/usage",
    );
  });
});

describe("getCloudrouterBalance four states", () => {
  beforeEach(() => {
    storage._resetBalanceCacheForTests();
    credState.default = null;
    credState.listed = [];
    credState.byId.clear();
  });

  it("no cloudrouter credential → available:false", async () => {
    credState.default = {
      id: "c1",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-x",
    };
    const r = await storage.getCloudrouterBalance(ctx, { skipCache: true });
    expect(r).toEqual({ available: false });
  });

  it("non-cloudrouter only list → available:false", async () => {
    const r = await storage.getCloudrouterBalance(ctx, { skipCache: true });
    expect(r).toEqual({ available: false });
  });

  it("success → remaining/unit/mode + updated_at", async () => {
    credState.default = {
      id: "cr",
      base_url: "https://console.cloudrouter.online/v1",
      api_key: "sk-secret",
    };
    const fetchImpl: storage.FetchUsageFn = async (url, apiKey) => {
      expect(url).toBe("https://console.cloudrouter.online/v1/usage");
      expect(apiKey).toBe("sk-secret");
      return {
        ok: true,
        status: 200,
        json: {
          balance: 12.5,
          remaining: 12.5,
          unit: "USD",
          planName: "钱包余额",
          mode: "unrestricted",
          isValid: true,
        },
      };
    };
    const r = await storage.getCloudrouterBalance(ctx, {
      fetchImpl,
      now: Date.parse("2026-07-28T04:00:00.000Z"),
      skipCache: true,
    });
    expect(r).toMatchObject({
      available: true,
      remaining: 12.5,
      unit: "USD",
      planName: "钱包余额",
      mode: "unrestricted",
      updated_at: "2026-07-28T04:00:00.000Z",
    });
  });

  it("quota_limited uses remaining (balance may be null)", async () => {
    credState.default = {
      id: "cr",
      base_url: "https://console.cloudrouter.online/v1",
      api_key: "sk-q",
    };
    const r = await storage.getCloudrouterBalance(ctx, {
      skipCache: true,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: { remaining: 100, balance: null, unit: "USD", mode: "quota_limited", isValid: true },
      }),
    });
    expect(r).toMatchObject({ available: true, remaining: 100, mode: "quota_limited" });
  });

  it("timeout / fetch throw → available:false", async () => {
    credState.default = {
      id: "cr",
      base_url: "https://console.cloudrouter.online/v1",
      api_key: "sk-x",
    };
    const r = await storage.getCloudrouterBalance(ctx, {
      skipCache: true,
      fetchImpl: async () => {
        throw new Error("TimeoutError");
      },
    });
    expect(r).toEqual({ available: false });
  });

  it("upstream non-2xx → available:false", async () => {
    credState.default = {
      id: "cr",
      base_url: "https://console.cloudrouter.online/v1",
      api_key: "sk-x",
    };
    const r = await storage.getCloudrouterBalance(ctx, {
      skipCache: true,
      fetchImpl: async () => ({ ok: false, status: 401, json: { error: "unauthorized" } }),
    });
    expect(r).toEqual({ available: false });
  });

  it("caches per user for 60s", async () => {
    credState.default = {
      id: "cr",
      base_url: "https://console.cloudrouter.online/v1",
      api_key: "sk-x",
    };
    let calls = 0;
    const fetchImpl: storage.FetchUsageFn = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: { remaining: calls, unit: "USD", mode: "unrestricted", isValid: true },
      };
    };
    const t0 = 1_000_000;
    const a = await storage.getCloudrouterBalance(ctx, { fetchImpl, now: t0 });
    const b = await storage.getCloudrouterBalance(ctx, { fetchImpl, now: t0 + 30_000 });
    expect(a).toMatchObject({ available: true, remaining: 1 });
    expect(b).toMatchObject({ available: true, remaining: 1 });
    expect(calls).toBe(1);
    const c = await storage.getCloudrouterBalance(ctx, { fetchImpl, now: t0 + 61_000 });
    expect(c).toMatchObject({ available: true, remaining: 2 });
    expect(calls).toBe(2);
  });

  it("falls back to listed personal cloudrouter when default is not", async () => {
    credState.default = {
      id: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-oai",
    };
    credState.listed = [
      { id: "cr", base_url: "https://console.cloudrouter.online/v1", scope: "personal", can_edit: true },
    ];
    credState.byId.set("cr", {
      id: "cr",
      base_url: "https://console.cloudrouter.online/v1",
      api_key: "sk-cr",
    });
    const r = await storage.getCloudrouterBalance(ctx, {
      skipCache: true,
      fetchImpl: async (_u, key) => {
        expect(key).toBe("sk-cr");
        return {
          ok: true,
          status: 200,
          json: { remaining: 3, unit: "USD", mode: "unrestricted", isValid: true },
        };
      },
    });
    expect(r).toMatchObject({ available: true, remaining: 3 });
  });
});
