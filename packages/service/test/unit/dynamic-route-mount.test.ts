import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Boot-order regression (review r1 on task-8a290a7d ①): dynamic-verification
 * routes mount in main.ts AFTER initEnterprise registers the provider.
 * The original bug: createApp checked isConfigured() before registration
 * could ever happen → enterprise/saas permanently lost /api/sandbox.
 * These tests pin the corrected contract against the mount helper itself.
 */

vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The mount helper dynamically imports the sandbox routers — stub them so no
// real MinIO/docker surface is touched.
vi.mock("../../src/features/sandboxes/capacity-routes.js", () => ({
  sandboxCapacityRouter: (() => {
    const { Hono } = require("hono") as typeof import("hono");
    const r = new Hono();
    r.get("/probe", (c) => c.json({ ok: true, router: "capacity" }));
    return r;
  })(),
}));
vi.mock("../../src/features/sandbox-plane/routes.js", () => ({
  sandboxPlaneInternalRouter: (() => {
    const { Hono } = require("hono") as typeof import("hono");
    const r = new Hono();
    r.post("/probe", (c) => c.json({ ok: true, router: "plane" }));
    return r;
  })(),
}));

import { Hono } from "hono";
import { setDynamicProvider, getDynamicProvider, type DynamicVerificationProvider } from "../../src/features/dynamic/provider.js";

function fakeProvider(configured: boolean): DynamicVerificationProvider {
  return {
    name: `test-${configured}`,
    ensureSandboxForTask: vi.fn(async () => ({ mapping: {} as never, reused: false })),
    stopSandboxForTask: vi.fn(async () => {}),
    resumeSandboxForTask: vi.fn(async () => {}),
    releaseSandboxForTask: vi.fn(async () => {}),
    reconcileSandboxes: vi.fn(async () => {}),
    getTaskSandbox: vi.fn(async () => null),
    peekTaskSshPrivateKey: vi.fn(async () => null),
    isConfigured: () => configured,
  };
}

describe("dynamic route mounting boot order (review r1)", () => {
  afterEach(() => {
    // restore a null-shaped default so tests in this file stay isolated
    setDynamicProvider(fakeProvider(false));
  });

  it("provider registered BEFORE mounting → routes are live (the enterprise boot order)", async () => {
    setDynamicProvider(fakeProvider(true));
    expect(getDynamicProvider().isConfigured()).toBe(true);

    const { mountDynamicRoutes } = await import("../../src/features/dynamic/routes.js");
    const app = new Hono();
    await mountDynamicRoutes(app);

    const res1 = await app.request("/api/sandbox/probe");
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ router: "capacity" });

    const res2 = await app.request("/internal/sandbox-plane/probe", { method: "POST" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ router: "plane" });
  });

  it("provider not configured → isConfigured() false and routes stay absent (community)", async () => {
    setDynamicProvider(fakeProvider(false));
    expect(getDynamicProvider().isConfigured()).toBe(false);
    // The main.ts caller skips mounting entirely on false — an unmounted Hono
    // app 404s, which is the community contract:
    const app = new Hono();
    const res = await app.request("/api/sandbox/anything");
    expect(res.status).toBe(404);
    const res2 = await app.request("/internal/sandbox-plane/apply", { method: "POST" });
    expect(res2.status).toBe(404);
  });
});
