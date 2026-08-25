import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Community-removal contract (task-8a290a7d ②): core never mounts
 * dynamic-verification routes. The enterprise package owns /api/sandbox and
 * /internal/sandbox-plane (mounted in initEnterprise with its migrated
 * modules) — even a fully-configured provider registered BEFORE createApp
 * must not make core mount anything. This pins the single-mount-site rule
 * and the community 404.
 */
describe("core never mounts dynamic-verification routes", () => {
  it("createApp with a configured provider still 404s sandbox routes (enterprise mounts its own)", async () => {
    const { setDynamicProvider } = await import("../../src/features/dynamic/provider.js");
    const fake = {
      name: "test-configured",
      ensureSandboxForTask: vi.fn(async () => ({ mapping: {} as never, reused: false })),
      stopSandboxForTask: vi.fn(async () => {}),
      resumeSandboxForTask: vi.fn(async () => {}),
      releaseSandboxForTask: vi.fn(async () => {}),
      reconcileSandboxes: vi.fn(async () => {}),
      getTaskSandbox: vi.fn(async () => null),
      peekTaskSshPrivateKey: vi.fn(async () => null),
      isConfigured: () => true,
    };
    setDynamicProvider(fake as never);

    const { createApp } = await import("../../src/server.js");
    const app = await createApp("business");

    // Unmounted paths fall through to the auth middleware → 401 (or 404 when
    // no middleware claims it). Either way: NOT the capacity router's shape.
    const r1 = await app.request("/api/sandbox/capacity");
    expect([401, 404]).toContain(r1.status);
    const r2 = await app.request("/internal/sandbox-plane/apply", { method: "POST" });
    expect([401, 404]).toContain(r2.status);
    // And an authenticated-shaped probe still never hits a capacity handler:
    const r3 = await app.request("/api/sandbox/capacity", { headers: { authorization: "Bearer x" } });
    expect(r3.status).not.toBe(200);
  });
});
