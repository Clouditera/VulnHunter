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
  beforeEach(() => {
    config = { max_parallel_scan: 3, youngflow_max_parallel: 3 };
    delete process.env.UPLOAD_GATEWAY_LIMIT_MB;
    delete process.env.VULNHUNTER_UPLOAD_GATEWAY_LIMIT_MB;
  });

  it("does not validate youngflow_max_parallel (deprecated, leave unread)", async () => {
    // Legacy key may still exist in DB; updates must not reject arbitrary values if present via merge
    await updateSystemConfig({ max_parallel_scan: 5 });
    const saved = await getSystemConfig();
    expect(saved).toMatchObject({ max_parallel_scan: 5 });
    // youngflow key retained from prior config without re-validation
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
});
