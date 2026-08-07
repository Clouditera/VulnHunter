import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /credential save gate (task-4393660d, QA-caught 422 regression):
 * a credential that PASSES all four layers must be saveable. The gate
 * reuses a fresh server-side test verdict (lastTestPass, keyed by a
 * fingerprint incl. key hash). This test verifies the happy path
 * end-to-end through the Hono router.
 */

// runPiDiagnostics (L1-L3) — default PASS
const runPiDiagnostics = vi.fn();
// runL4Check (L4 agent circuit) — default PASS
const runL4Check = vi.fn();

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
vi.mock("../../src/features/settings/storage.js", () => ({
  getCredentialById: vi.fn(),
  getDefaultCredential: vi.fn(),
  listCredentials: vi.fn(async () => []),
  deleteCredential: vi.fn(),
  setDefaultCredential: vi.fn(),
  upsertCredential: vi.fn(async (p: { id?: string }) => p.id ?? "new-cred-id"),
  updateCredentialMeta: vi.fn(),
  updateDeepVerifiedStatus: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/settings/pi-diagnostics.js", () => ({
  runPiDiagnostics: (...a: unknown[]) => runPiDiagnostics(...a),
}));
vi.mock("../../src/features/settings/l4-agent-check.js", () => ({
  runL4Check: (...a: unknown[]) => runL4Check(...a),
}));
vi.mock("../../src/features/settings/pi-model-catalog.js", () => ({ lookupModelMeta: vi.fn() }));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: vi.fn(() => ({ edition: "enterprise" })) }));
vi.mock("../../src/features/reports/storage.js", () => ({}));
vi.mock("../../src/infra/minio/client.js", () => ({ uploadFile: vi.fn(), getMinio: vi.fn() }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { settingsRouter } = await import("../../src/features/settings/routes.js");

const PASS_DIAG = { ok: true, checks: [{ id: "basic", status: "pass" }] };
const PASS_L4 = { status: "pass", durationMs: 100, detail: "ok" };

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
    runL4Check.mockReset();
    runPiDiagnostics.mockResolvedValue(PASS_DIAG);
    runL4Check.mockResolvedValue(PASS_L4);
  });

  it("passes all four layers → save 200 (no false negative on the gate)", async () => {
    const res = await putCredential(NEW_CRED_BODY);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ id: "new-cred-id" });
    // Diagnostics must have run (cache was empty for a new credential)
    expect(runPiDiagnostics).toHaveBeenCalledTimes(1);
    expect(runL4Check).toHaveBeenCalledTimes(1);
  });

  it("second save reuses the fresh-pass cache (no re-run)", async () => {
    const r1 = await putCredential(NEW_CRED_BODY);
    expect(r1.status).toBe(200);
    runPiDiagnostics.mockClear();
    runL4Check.mockClear();

    const r2 = await putCredential(NEW_CRED_BODY);
    expect(r2.status).toBe(200);
    // cache hit → no diagnostics re-run
    expect(runPiDiagnostics).not.toHaveBeenCalled();
    expect(runL4Check).not.toHaveBeenCalled();
  });

  it("L4 fail → 422 with real checks (not empty)", async () => {
    runL4Check.mockResolvedValue({ status: "fail", durationMs: 100, detail: "agent failed" });
    // Distinct credential (fresh fingerprint) so the cache from prior tests
    // doesn't mask the failure run.
    const res = await putCredential({ ...NEW_CRED_BODY, api_key: "sk-different-fail-key" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("ERR_CREDENTIAL_TEST_FAILED");
    // The checks array must carry real check results, NOT be empty
    expect(body.error.checks.length).toBeGreaterThan(0);
  });
});
