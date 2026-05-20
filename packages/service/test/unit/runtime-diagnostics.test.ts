import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const createWorkerContainer = vi.fn();
const removeWorkDir = vi.fn();
const ensureWorkDir = vi.fn();

vi.mock("../../src/features/workers/docker-client.js", () => ({
  createWorkerContainer,
  ensureWorkDir,
  removeWorkDir,
  getDocker: () => ({ getContainer: () => ({ inspect: async () => ({ NetworkSettings: { Networks: { "test-net": { IPAddress: "172.18.0.2" } } } }) }) }),
}));

vi.mock("../../src/features/settings/model-diagnostics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/features/settings/model-diagnostics.js")>("../../src/features/settings/model-diagnostics.js");
  return {
    ...actual,
    runBasicChecks: vi.fn(async () => ({ ok: false, summary: "bad", checks: [{ id: "basic", label: "基础文本生成", status: "fail", message: "HTTP 401" }] })),
  };
});

const { diagnoseModelRuntimeCredential } = await import("../../src/features/settings/runtime-diagnostics.js");

describe("diagnoseModelRuntimeCredential", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops before worker startup when basic preflight fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "vh-runtime-diag-"));
    const result = await diagnoseModelRuntimeCredential({
      id: "cred-1",
      tenant_id: "tenant",
      provider: "test",
      proto_type: "openai-completions",
      base_url: "http://model/v1",
      model_id: "model",
      api_key: "key",
      context_window_tokens: 128000,
      is_default: false,
      created_at: new Date(),
      updated_at: new Date(),
    } as any, {
      port: 28080,
      dataDir,
      docker: { workerImage: "worker:test", network: "test-net", socketPath: "/var/run/docker.sock" },
      minio: {} as any,
      db: {} as any,
      log: {} as any,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("基础文本生成失败");
    expect(createWorkerContainer).not.toHaveBeenCalled();
    expect(ensureWorkDir).not.toHaveBeenCalled();
    expect(removeWorkDir).not.toHaveBeenCalled();
  });
});
