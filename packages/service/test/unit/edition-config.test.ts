import { afterEach, describe, expect, it, vi } from "vitest";

describe("EDITION config", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
  });

  it("accepts community / enterprise / saas", async () => {
    for (const edition of ["community", "enterprise", "saas"] as const) {
      process.env.EDITION = edition;
      vi.resetModules();
      const { loadConfig } = await import("../../src/infra/config.js");
      expect(loadConfig().edition).toBe(edition);
    }
  });

  it("rejects invalid edition", async () => {
    process.env.EDITION = "foo";
    vi.resetModules();
    const { loadConfig } = await import("../../src/infra/config.js");
    expect(() => loadConfig()).toThrow(/Invalid EDITION/);
  });

  it("defaults to community", async () => {
    delete process.env.EDITION;
    vi.resetModules();
    const { loadConfig } = await import("../../src/infra/config.js");
    expect(loadConfig().edition).toBe("community");
  });
});
