import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PATCH /api/settings/credential/:id must refuse core fields — including
 * thinking_effort since 2026-08-06 (QA-caught side door: direct PATCH
 * changed thinking without a test while the PUT gate was already fixed).
 */

const updateMeta = vi.fn(async () => true);

vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
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
  upsertCredential: vi.fn(),
  updateCredentialMeta: updateMeta,
}));
vi.mock("../../src/features/settings/pi-diagnostics.js", () => ({ runPiDiagnostics: vi.fn() }));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/features/reports/storage.js", () => ({}));
vi.mock("../../src/infra/minio/client.js", () => ({ uploadFile: vi.fn(), getMinio: vi.fn() }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { settingsRouter } = await import("../../src/features/settings/routes.js");
settingsRouter.onError((err, c) => {
  const appError = err as { code?: string };
  if (appError.code === "ERR_CREDENTIAL_CORE_FIELD_REQUIRES_TEST") {
    return c.json({ error: { code: appError.code } }, 422);
  }
  throw err;
});

const REJECTED = ["proto_type", "base_url", "model_id", "thinking_effort"] as const;

describe("PATCH /credential/:id core-field side door", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const field of REJECTED) {
    it(`refuses ${field} (must go through gated PUT)`, async () => {
      const res = await settingsRouter.request("/credential/cred-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: field === "base_url" ? "https://api.example.com/v1" : "x" }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: { code: "ERR_CREDENTIAL_CORE_FIELD_REQUIRES_TEST" } });
      expect(updateMeta).not.toHaveBeenCalled();
    });
  }

  it("still allows optional metadata (label)", async () => {
    const res = await settingsRouter.request("/credential/cred-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "renamed" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updateMeta).toHaveBeenCalledWith(expect.objectContaining({ label: "renamed" }));
  });
});
