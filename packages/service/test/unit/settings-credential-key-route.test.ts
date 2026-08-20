import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCredentialById: vi.fn(),
  loggerInfo: vi.fn(),
}));

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
  getCredentialById: mocks.getCredentialById,
  getDefaultCredential: vi.fn(),
  listCredentials: vi.fn(async () => []),
  deleteCredential: vi.fn(),
  setDefaultCredential: vi.fn(),
  upsertCredential: vi.fn(),
}));
vi.mock("../../src/features/settings/pi-diagnostics.js", () => ({ runPiDiagnostics: vi.fn() }));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: vi.fn() }));
vi.mock("../../src/features/reports/storage.js", () => ({}));
vi.mock("../../src/infra/minio/client.js", () => ({ uploadFile: vi.fn(), getMinio: vi.fn() }));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { settingsRouter } = await import("../../src/features/settings/routes.js");
settingsRouter.onError((err, c) => {
  const appError = err as { code?: string };
  if (appError.code === "ERR_NOT_FOUND") return c.json({ error: { code: appError.code } }, 404);
  throw err;
});

describe("GET /credentials/:id/key", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the decrypted key for a credential visible to the current user", async () => {
    mocks.getCredentialById.mockResolvedValue({ id: "cred-1", api_key: "sk-saved-secret" });

    const res = await settingsRouter.request("/credentials/cred-1/key");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ api_key: "sk-saved-secret" });
    expect(mocks.getCredentialById).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      "cred-1",
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.not.objectContaining({ api_key: expect.anything() }),
      "Credential API key revealed",
    );
  });

  it("does not disclose whether an inaccessible credential exists", async () => {
    mocks.getCredentialById.mockResolvedValue(null);

    const res = await settingsRouter.request("/credentials/other-user-cred/key");

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("api_key");
  });
});
