import { beforeEach, describe, expect, it, vi } from "vitest";

let config: Record<string, unknown> = { max_parallel_scan: 3, youngflow_max_parallel: 3 };

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () => async (strings: TemplateStringsArray, ...values: any[]) => {
    const sql = strings.join("?");
    if (sql.includes("SELECT config FROM system_config")) return [{ config }];
    if (sql.includes("UPDATE system_config")) {
      config = JSON.parse(values[0]);
      return [];
    }
    return [];
  },
}));

const { updateSystemConfig, getSystemConfig } = await import("../../src/features/settings/storage.js");

describe("system config concurrency validation", () => {
  beforeEach(() => { config = { max_parallel_scan: 3, youngflow_max_parallel: 3 }; });

  it("saves valid youngflow_max_parallel", async () => {
    await updateSystemConfig({ youngflow_max_parallel: 10 });
    await expect(getSystemConfig()).resolves.toMatchObject({ youngflow_max_parallel: 10 });
  });

  it("rejects out-of-range youngflow_max_parallel", async () => {
    await expect(updateSystemConfig({ youngflow_max_parallel: 0 })).rejects.toThrow("invalid youngflow_max_parallel");
    await expect(updateSystemConfig({ youngflow_max_parallel: 11 })).rejects.toThrow("invalid youngflow_max_parallel");
  });
});
