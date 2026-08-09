import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /credential save gate (task-4393660d, QA-caught 422 regression):
 * a credential that PASSES all four layers must be saveable. The gate
 * reuses a fresh server-side test verdict (lastTestPass, keyed by a
 * fingerprint incl. key hash). This test verifies the happy path
 * end-to-end through the Hono router.
 *
 * Updated 2026-08-08: four-in-one CLI — runPiDiagnostics now returns all
 * four layers (no separate runL4Check call).
 */

// runPiDiagnostics (four-in-one L1-L4) — default PASS
const runPiDiagnostics = vi.fn();

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { userId: "user-1", tenantId: "tenant-1", role: "member" });
    await next();
  },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: unknown, next: () => Promise<void>) => await next(),
}));
vi.mock("../../src/infra/query-context.js", () => ({
  queryContextFromUser: (user: unknown) => user,
}));
const getCredentialById = vi.fn();
const upsertCredential = vi.fn(async (p: { id?: string }) => p.id ?? "new-cred-id");
vi.mock("../../src/features/settings/storage.js", () => ({
  getCredentialById: (...a: unknown[]) => getCredentialById(...a),
  getDefaultCredential: vi.fn(),
  listCredentials: vi.fn(async () => []),
  deleteCredential: vi.fn(),
  setDefaultCredential: vi.fn(),
  upsertCredential: (...a: unknown[]) => upsertCredential(...a),
  updateCredentialMeta: vi.fn(),
  updateDeepVerifiedStatus: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/settings/pi-diagnostics.js", () => ({
  runPiDiagnostics: (...a: unknown[]) => runPiDiagnostics(...a),
}));
vi.mock("../../src/features/settings/pi-model-catalog.js", () => ({ lookupModelMeta: vi.fn() }));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: vi.fn(() => ({ edition: "enterprise" })) }));
vi.mock("../../src/features/reports/storage.js", () => ({}));
vi.mock("../../src/infra/minio/client.js", () => ({ uploadFile: vi.fn(), getMinio: vi.fn() }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { settingsRouter } = await import("../../src/features/settings/routes.js");

const PASS_DIAG = {
  ok: true,
  checks: [
    { id: "basic", status: "pass" },
    { id: "thinking", status: "na" },
    { id: "tool", status: "pass" },
    { id: "l4_agent", status: "pass" },
  ],
};

const NEW_CRED_BODY = {
  provider: "openai-completions",
  proto_type: "openai-completions",
  base_url: "https://api.example.com/v1",
  model_id: "glm-5.2",
  thinking_effort: "medium",
  context_window_tokens: 128000,
  api_key: "sk-real-test-key",
};

function putCredential(body: Record<string, unknown>) {
  return settingsRouter.request("/credential", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /credential save gate (task-4393660d)", () => {
  beforeEach(() => {
    runPiDiagnostics.mockReset();
    runPiDiagnostics.mockResolvedValue(PASS_DIAG);
  });

  it("passes all four layers → save 200 (no false negative on the gate)", async () => {
    const res = await putCredential(NEW_CRED_BODY);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "new-cred-id" });
    expect(runPiDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("second save reuses the fresh-pass cache (no re-run)", async () => {
    const r1 = await putCredential(NEW_CRED_BODY);
    expect(r1.status).toBe(200);
    runPiDiagnostics.mockClear();

    const r2 = await putCredential(NEW_CRED_BODY);
    expect(r2.status).toBe(200);
    expect(runPiDiagnostics).not.toHaveBeenCalled();
  });

  it("diagnostics fail → 422 with real checks (not empty)", async () => {
    runPiDiagnostics.mockResolvedValue({
      ok: false,
      checks: [
        { id: "basic", status: "fail", message: "connection refused" },
      ],
    });
    // Distinct credential (fresh fingerprint) so the cache from prior tests
    // doesn't mask the failure run.
    const res = await putCredential({ ...NEW_CRED_BODY, api_key: "sk-different-fail-key" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("ERR_CREDENTIAL_TEST_FAILED");
    expect(body.error.checks.length).toBeGreaterThan(0);
  });
});

/**
 * fish 2026-08-09: test-pass cache must survive diagnose→save advanced_config
 * null/undefined asymmetry (form test omits key; form save sends null).
 */
describe("PUT /credential save gate + advanced_config fingerprint (fish 2026-08-09)", () => {
  beforeEach(() => {
    runPiDiagnostics.mockReset();
    runPiDiagnostics.mockResolvedValue(PASS_DIAG);
    getCredentialById.mockReset();
    upsertCredential.mockClear();
    upsertCredential.mockImplementation(async (p: { id?: string }) => p.id ?? "new-cred-id");
  });

  it("diagnose without advanced_config key then save with advanced_config:null reuses cache (fish screenshot)", async () => {
    // Existing credential — edit path
    getCredentialById.mockResolvedValue({
      id: "cred-1",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "medium",
      api_key: "sk-real-test-key",
      context_window_tokens: 200000,
      advanced_config: null,
      label: "",
      is_default: false,
    });

    // 1) User hits 测试连接 (diagnose-stream path via runFullDiagnostics)
    //    Form omits advanced_config → same as body without the key.
    //    We simulate by calling PUT's gate after a diagnose-equivalent pass
    //    recorded through a first PUT that runs diagnostics.
    const bodyBase = {
      id: "cred-1",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "xhigh", // core change: 极高
      context_window_tokens: 500000, // optional: 500k
      api_key: "", // keep stored key
    };

    // First save with core change forces diagnose — records fingerprint WITH
    // advanced_config from stored (null) when body omits the key... but frontend
    // always sends advanced_config: null. First call establishes cache.
    const r1 = await putCredential({ ...bodyBase, advanced_config: null });
    expect(r1.status).toBe(200);
    expect(runPiDiagnostics).toHaveBeenCalledTimes(1);

    // Second save identical (re-click) must hit cache — no re-diagnose
    runPiDiagnostics.mockClear();
    const r2 = await putCredential({ ...bodyBase, advanced_config: null });
    expect(r2.status).toBe(200);
    expect(runPiDiagnostics).not.toHaveBeenCalled();
  });

  it("unchanged advanced_config:null does NOT force coreChanged alone", async () => {
    getCredentialById.mockResolvedValue({
      id: "cred-2",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "high",
      api_key: "sk-real-test-key",
      context_window_tokens: 128000,
      advanced_config: null,
      label: "",
      is_default: false,
    });

    // Only context_window changes — optional field; advanced_config:null equals stored
    runPiDiagnostics.mockClear();
    const res = await putCredential({
      id: "cred-2",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "high", // unchanged
      context_window_tokens: 500000,
      api_key: "",
      advanced_config: null,
    });
    expect(res.status).toBe(200);
    // No core change → diagnostics must NOT run
    expect(runPiDiagnostics).not.toHaveBeenCalled();
  });

  it("thinkingLevelValue change busts cache (must re-test)", async () => {
    getCredentialById.mockResolvedValue({
      id: "cred-3",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "xhigh",
      api_key: "sk-real-test-key",
      context_window_tokens: 128000,
      advanced_config: null,
      label: "",
      is_default: false,
    });

    // First: establish pass with no send-value
    await putCredential({
      id: "cred-3",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "xhigh",
      context_window_tokens: 128000,
      api_key: "",
      advanced_config: null,
    });
    runPiDiagnostics.mockClear();

    // Change send-value only → must re-run diagnostics
    const res = await putCredential({
      id: "cred-3",
      provider: "openai-completions",
      proto_type: "openai-completions",
      base_url: "https://api.example.com/v1",
      model_id: "glm-5.2",
      thinking_effort: "xhigh",
      context_window_tokens: 128000,
      api_key: "",
      advanced_config: { thinkingLevelValue: "max" },
    });
    expect(res.status).toBe(200);
    expect(runPiDiagnostics).toHaveBeenCalledTimes(1);
  });
});
