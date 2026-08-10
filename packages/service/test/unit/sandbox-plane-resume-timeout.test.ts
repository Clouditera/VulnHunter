import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SandboxPlane resume: write timeout tier + TimeoutError typing
 * (fish / architect 2026-08-10 — "platform waited too short").
 */

const loadConfig = vi.fn();
vi.mock("../../src/infra/config.js", () => ({ loadConfig: () => loadConfig() }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  resumeSandboxPlaneSandbox,
  stopSandboxPlaneSandbox,
  releaseSandboxPlaneSandbox,
  SandboxPlaneTimeoutError,
  SandboxPlaneUnavailableError,
} = await import("../../src/features/sandbox-plane/client.js");

const sandboxBody = {
  sandbox: {
    sandbox_id: "sb-1",
    request_id: "req-1",
    consumer: "vulnhunter",
    profile_id: "linux-docker",
    status: "running",
    ssh: { host: "10.0.0.5", port: 22, user: "sandbox" },
    external_ref: null,
    failure_reason: null,
    error_code: null,
  },
};

beforeEach(() => {
  loadConfig.mockReturnValue({
    sandboxPlane: {
      baseUrl: "http://plane.test",
      token: "tok",
      timeoutMs: 5_000,
      writeTimeoutMs: 60_000,
    },
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resumeSandboxPlaneSandbox timeouts", () => {
  it("uses writeTimeoutMs for resume POST", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sandboxBody,
    });
    await resumeSandboxPlaneSandbox("sb-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://plane.test/sandboxes/sb-1/resume",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("maps AbortError → SandboxPlaneTimeoutError with seconds in message", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);

    await expect(resumeSandboxPlaneSandbox("sb-1")).rejects.toBeInstanceOf(SandboxPlaneTimeoutError);
    try {
      await resumeSandboxPlaneSandbox("sb-1");
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxPlaneTimeoutError);
      const te = e as InstanceType<typeof SandboxPlaneTimeoutError>;
      expect(te.timeoutMs).toBe(60_000);
      expect(te.message).toMatch(/timed out after 60s/);
      expect(te.message).toMatch(/resume/);
    }
  });

  it("HTTP 404 → SandboxPlaneUnavailableError (not timeout)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "NOT_FOUND" } }),
    });
    await expect(resumeSandboxPlaneSandbox("sb-gone")).rejects.toBeInstanceOf(
      SandboxPlaneUnavailableError,
    );
    await expect(resumeSandboxPlaneSandbox("sb-gone")).rejects.not.toBeInstanceOf(
      SandboxPlaneTimeoutError,
    );
    await expect(resumeSandboxPlaneSandbox("sb-gone")).rejects.toThrow(/HTTP 404/);
  });
});

describe("stop/release timeout tier", () => {
  it("stop and release still succeed with 15s tier (happy path)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sandboxBody,
    });
    await expect(stopSandboxPlaneSandbox("sb-1")).resolves.toMatchObject({ sandbox_id: "sb-1" });
    await expect(releaseSandboxPlaneSandbox("sb-1")).resolves.toMatchObject({ sandbox_id: "sb-1" });
  });
});
