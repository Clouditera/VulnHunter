import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () => Object.assign(async () => [], { json: (v: unknown) => v }),
}));

vi.mock("../../src/features/auth/storage.js", () => ({
  findUserByEmail: vi.fn(async () => null),
  createSession: vi.fn(),
  updateLastLogin: vi.fn(),
  getUserById: vi.fn(),
  findSession: vi.fn(),
  deleteSession: vi.fn(),
  hasAnyAdmin: vi.fn(),
  createUser: vi.fn(),
}));

const {
  login,
  _resetLoginAttemptsForTests,
  _getLoginAttemptEntryForTests,
  clearLoginLockoutForEmail,
  LOGIN_LOCKOUT,
} = await import("../../src/features/auth/service.js");

describe("login lockout expiry", () => {
  beforeEach(() => {
    _resetLoginAttemptsForTests();
  });

  it("locks after MAX_ATTEMPTS failures", async () => {
    const email = "user@example.com";
    const ip = "10.0.0.1";
    for (let i = 0; i < LOGIN_LOCKOUT.MAX_ATTEMPTS; i++) {
      const r = await login({ email, password: "x", ip });
      expect(r).toEqual({ error: "invalid_credentials" });
    }
    const locked = await login({ email, password: "x", ip });
    expect(locked).toEqual({ error: "locked" });
    const entry = _getLoginAttemptEntryForTests(ip, email);
    expect(entry?.count).toBe(LOGIN_LOCKOUT.MAX_ATTEMPTS);
    expect(entry!.lockedUntil).toBeGreaterThan(Date.now());
  });

  it("auto-clears after lockout window (was permanent before fix)", async () => {
    const email = "user@example.com";
    const ip = "10.0.0.2";
    for (let i = 0; i < LOGIN_LOCKOUT.MAX_ATTEMPTS; i++) {
      await login({ email, password: "x", ip });
    }
    expect(await login({ email, password: "x", ip })).toEqual({ error: "locked" });

    // Fast-forward: mutate lockedUntil into the past
    const entry = _getLoginAttemptEntryForTests(ip, email)!;
    entry.lockedUntil = Date.now() - 1;

    // Next attempt must NOT be locked forever — counts as a fresh invalid login
    const after = await login({ email, password: "x", ip });
    expect(after).toEqual({ error: "invalid_credentials" });
    // Counter restarted at 1
    expect(_getLoginAttemptEntryForTests(ip, email)?.count).toBe(1);
  });

  it("clearLoginLockoutForEmail removes all IPs for that email", async () => {
    const email = "panpanwang@clouditera.com";
    await login({ email, password: "x", ip: "1.1.1.1" });
    await login({ email, password: "x", ip: "2.2.2.2" });
    expect(clearLoginLockoutForEmail(email)).toBe(2);
    expect(_getLoginAttemptEntryForTests("1.1.1.1", email)).toBeNull();
    expect(_getLoginAttemptEntryForTests("2.2.2.2", email)).toBeNull();
  });
});
