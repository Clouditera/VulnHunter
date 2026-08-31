import { beforeEach, describe, expect, it, vi } from "vitest";

let config: Record<string, unknown> = { max_parallel_scan: 3, youngflow_max_parallel: 3 };

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () => Object.assign(async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    if (sql.includes("SELECT config FROM system_config")) return [{ config }];
    if (sql.includes("UPDATE system_config")) {
      config = values[0];
      return [];
    }
    return [];
  }, { json: (value: unknown) => value }),
}));

const { updateSystemConfig, getSystemConfig } = await import("../../src/features/settings/storage.js");

describe("system config validation", () => {
  it("allows high max_parallel_scan without upper bound", async () => {
    await updateSystemConfig({ max_parallel_scan: 50 });
    const saved = await getSystemConfig();
    expect(saved).toMatchObject({ max_parallel_scan: 50 });
  });
  it("rejects non-positive max_parallel_scan", async () => {
    await expect(updateSystemConfig({ max_parallel_scan: 0 })).rejects.toThrow(/max_parallel_scan/);
  });

  beforeEach(() => {
    config = { max_parallel_scan: 3, youngflow_max_parallel: 3 };
    delete process.env.UPLOAD_GATEWAY_LIMIT_MB;
    delete process.env.VULNHUNTER_UPLOAD_GATEWAY_LIMIT_MB;
  });

  it("ignores youngflow_max_parallel patch and keeps legacy key", async () => {
    await updateSystemConfig({ youngflow_max_parallel: 10 });
    const saved = await getSystemConfig();
    // patch is not accepted; prior value preserved for rollback safety
    expect(saved).toMatchObject({ youngflow_max_parallel: 3 });
    expect(typeof saved).toBe("object");
    expect(typeof config).toBe("object");
  });

  it("does not validate youngflow_max_parallel range anymore", async () => {
    await expect(updateSystemConfig({ youngflow_max_parallel: 0 })).resolves.toBeUndefined();
    await expect(updateSystemConfig({ youngflow_max_parallel: 11 })).resolves.toBeUndefined();
    // still the legacy stored value
    await expect(getSystemConfig()).resolves.toMatchObject({ youngflow_max_parallel: 3 });
  });

  it("preserves legacy youngflow key on unrelated patch (deprecated, leave unread)", async () => {
    await updateSystemConfig({ max_parallel_scan: 5 });
    const saved = await getSystemConfig();
    expect(saved).toMatchObject({ max_parallel_scan: 5 });
    expect(saved.youngflow_max_parallel).toBe(3);
  });

  it("uses deployment upload ceiling for source archive setting validation", async () => {
    process.env.UPLOAD_GATEWAY_LIMIT_MB = "4096";
    await updateSystemConfig({ source_archive_upload_max_mb: 4096 });
    await expect(getSystemConfig()).resolves.toMatchObject({
      source_archive_upload_max_mb: 4096,
      upload_zip_max_mb: 4096,
      source_archive_upload_ceiling_mb: 4096,
      upload_gateway_limit_mb: 4096,
      source_archive_effective_max_mb: 4096,
    });
    await expect(updateSystemConfig({ source_archive_upload_max_mb: 4097 })).rejects.toThrow("source_archive_upload_max_mb must be an integer between 1 and 4096");
  });

  it("clamps read-side source archive setting to lowered deployment ceiling", async () => {
    config = { max_parallel_scan: 3, youngflow_max_parallel: 3, source_archive_upload_max_mb: 4096, upload_zip_max_mb: 4096 };
    process.env.UPLOAD_GATEWAY_LIMIT_MB = "500";
    await expect(getSystemConfig()).resolves.toMatchObject({
      source_archive_upload_max_mb: 500,
      upload_zip_max_mb: 500,
      source_archive_upload_ceiling_mb: 500,
      source_archive_effective_max_mb: 500,
    });
  });

  it("keeps config object-shaped across consecutive updates", async () => {
    await updateSystemConfig({ max_parallel_scan: 2 });
    await updateSystemConfig({ max_parallel_scan: 1 });
    const saved = await getSystemConfig();
    expect(saved).toMatchObject({ max_parallel_scan: 1 });
    expect(saved).not.toHaveProperty("0");
  });

  it("parses legacy JSON-string config defensively", async () => {
    config = JSON.stringify({ max_parallel_scan: 2, youngflow_max_parallel: 4 }) as any;
    await expect(getSystemConfig()).resolves.toMatchObject({ max_parallel_scan: 2, youngflow_max_parallel: 4 });
  });

  it("accepts boolean cloudrouter_promo_enabled", async () => {
    await updateSystemConfig({ cloudrouter_promo_enabled: false });
    await expect(getSystemConfig()).resolves.toMatchObject({ cloudrouter_promo_enabled: false });
    await updateSystemConfig({ cloudrouter_promo_enabled: true });
    await expect(getSystemConfig()).resolves.toMatchObject({ cloudrouter_promo_enabled: true });
  });

  it("rejects non-boolean cloudrouter_promo_enabled", async () => {
    await expect(updateSystemConfig({ cloudrouter_promo_enabled: "yes" })).rejects.toThrow(
      "cloudrouter_promo_enabled must be a boolean",
    );
  });
});

describe("sandbox_idle_release_hours validation (task-ac572a8e C)", () => {
  beforeEach(() => {
    config = { max_parallel_scan: 3 };
  });

  it("accepts in-range integers (1..720) and persists", async () => {
    await updateSystemConfig({ sandbox_idle_release_hours: 1 });
    await expect(getSystemConfig()).resolves.toMatchObject({ sandbox_idle_release_hours: 1 });
    await updateSystemConfig({ sandbox_idle_release_hours: 720 });
    await expect(getSystemConfig()).resolves.toMatchObject({ sandbox_idle_release_hours: 720 });
  });

  it("rejects 0 and negatives", async () => {
    await expect(updateSystemConfig({ sandbox_idle_release_hours: 0 })).rejects.toThrow(/sandbox_idle_release_hours/);
    await expect(updateSystemConfig({ sandbox_idle_release_hours: -5 })).rejects.toThrow(/sandbox_idle_release_hours/);
  });

  it("rejects non-integers and out-of-range values", async () => {
    await expect(updateSystemConfig({ sandbox_idle_release_hours: 1.5 })).rejects.toThrow(/sandbox_idle_release_hours/);
    await expect(updateSystemConfig({ sandbox_idle_release_hours: 721 })).rejects.toThrow(/sandbox_idle_release_hours/);
  });

  it("keeps the stored value on unrelated patches; absence stays absent", async () => {
    await updateSystemConfig({ max_parallel_scan: 5 });
    expect((await getSystemConfig()).sandbox_idle_release_hours).toBeUndefined();
    await updateSystemConfig({ sandbox_idle_release_hours: 48 });
    await updateSystemConfig({ max_parallel_scan: 6 });
    await expect(getSystemConfig()).resolves.toMatchObject({ sandbox_idle_release_hours: 48, max_parallel_scan: 6 });
  });
});
