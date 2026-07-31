import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two credential resolvers so the test exercises injectUser's
// branching (cookie priority, vht_ Bearer fallback) without a live DB.
const resolveSession = vi.fn();
const resolveApiToken = vi.fn();

vi.mock("../../src/features/auth/service.js", () => ({
  resolveSession: (...args: unknown[]) => resolveSession(...args),
}));
vi.mock("../../src/features/auth/api-token-storage.js", () => ({
  resolveApiToken: (...args: unknown[]) => resolveApiToken(...args),
}));

const { injectUser, requireAuth } = await import("../../src/middleware/auth.js");

const COOKIE_USER = {
  userId: "u-cookie",
  tenantId: "t1",
  email: "cookie@example.com",
  role: "member",
  displayName: "Cookie User",
  sessionId: "real-session-id",
};
const TOKEN_USER = {
  userId: "u-token",
  tenantId: "t1",
  email: "svc@example.com",
  role: "member",
  displayName: "Service Account",
  sessionId: "apitoken:tok-1",
};

function makeApp() {
  const app = new Hono();
  app.use("*", injectUser);
  app.get("/api/tasks", requireAuth, (c) => c.json({ userId: c.get("user")?.userId }));
  return app;
}

describe("injectUser Bearer API-token fallback", () => {
  beforeEach(() => {
    resolveSession.mockReset();
    resolveApiToken.mockReset();
    resolveSession.mockResolvedValue(null);
    resolveApiToken.mockResolvedValue(null);
  });

  it("criterion 1: a valid vht_ Bearer token authenticates the request", async () => {
    resolveApiToken.mockResolvedValue(TOKEN_USER);
    const res = await makeApp().request("/api/tasks", {
      headers: { authorization: "Bearer vht_goodtoken" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u-token" });
    expect(resolveApiToken).toHaveBeenCalledWith("vht_goodtoken");
  });

  it("criterion 2: no credentials → 401", async () => {
    const res = await makeApp().request("/api/tasks");
    expect(res.status).toBe(401);
    expect(resolveApiToken).not.toHaveBeenCalled();
  });

  it("criterion 2: an invalid / revoked token (resolver returns null) → 401", async () => {
    resolveApiToken.mockResolvedValue(null);
    const res = await makeApp().request("/api/tasks", {
      headers: { authorization: "Bearer vht_revoked" },
    });
    expect(res.status).toBe(401);
  });

  it("criterion 3 (regression): a valid session cookie still authenticates", async () => {
    resolveSession.mockResolvedValue(COOKIE_USER);
    const res = await makeApp().request("/api/tasks", {
      headers: { cookie: "va_session=abc123" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u-cookie" });
    // Bearer path is not consulted when the cookie resolves.
    expect(resolveApiToken).not.toHaveBeenCalled();
  });

  it("criterion 5: when both cookie and Bearer are present, the cookie wins", async () => {
    resolveSession.mockResolvedValue(COOKIE_USER);
    resolveApiToken.mockResolvedValue(TOKEN_USER);
    const res = await makeApp().request("/api/tasks", {
      headers: { cookie: "va_session=abc123", authorization: "Bearer vht_goodtoken" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u-cookie" });
    expect(resolveApiToken).not.toHaveBeenCalled();
  });

  it("ignores a non-vht_ Bearer token (e.g. internal task-id bearer) — leaves it for other middleware", async () => {
    const res = await makeApp().request("/api/tasks", {
      headers: { authorization: "Bearer 123e4567-e89b-12d3-a456-426614174000" },
    });
    expect(res.status).toBe(401);
    // Regex only matches vht_ tokens, so the API-token resolver is never called.
    expect(resolveApiToken).not.toHaveBeenCalled();
  });

  it("falls back to Bearer when the cookie is present but invalid", async () => {
    resolveSession.mockResolvedValue(null); // stale/invalid cookie
    resolveApiToken.mockResolvedValue(TOKEN_USER);
    const res = await makeApp().request("/api/tasks", {
      headers: { cookie: "va_session=stale", authorization: "Bearer vht_goodtoken" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u-token" });
    expect(resolveApiToken).toHaveBeenCalledWith("vht_goodtoken");
  });
});
