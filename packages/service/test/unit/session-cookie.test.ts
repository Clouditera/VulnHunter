import { describe, it, expect, afterEach } from "vitest";
import { sessionCookieName } from "../../src/features/auth/session-cookie.js";

describe("sessionCookieName", () => {
  const prev = process.env.SERVICE_ROLE;
  afterEach(() => {
    if (prev === undefined) delete process.env.SERVICE_ROLE;
    else process.env.SERVICE_ROLE = prev;
  });

  it("business → va_session", () => {
    process.env.SERVICE_ROLE = "business";
    expect(sessionCookieName()).toBe("va_session");
  });

  it("admin → va_admin_session", () => {
    process.env.SERVICE_ROLE = "admin";
    expect(sessionCookieName()).toBe("va_admin_session");
  });

  it("default → va_session", () => {
    delete process.env.SERVICE_ROLE;
    expect(sessionCookieName()).toBe("va_session");
  });
});
