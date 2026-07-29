import { describe, it, expect } from "vitest";
import { parseCookieHeader, rejectUpgrade } from "../../src/ws-auth.js";

describe("parseCookieHeader", () => {
  it("parses multiple cookies", () => {
    const c = parseCookieHeader("va_session=abc123; other=xyz");
    expect(c.va_session).toBe("abc123");
    expect(c.other).toBe("xyz");
  });

  it("handles empty / missing", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("decodes URI components", () => {
    const c = parseCookieHeader("va_session=a%2Fb");
    expect(c.va_session).toBe("a/b");
  });
});

describe("rejectUpgrade", () => {
  it("writes 401 and destroys", () => {
    const writes: string[] = [];
    let destroyed = false;
    rejectUpgrade(
      {
        write: (s: string) => {
          writes.push(s);
        },
        destroy: () => {
          destroyed = true;
        },
      },
      401,
      "Unauthorized",
    );
    expect(writes[0]).toMatch(/^HTTP\/1\.1 401/);
    expect(destroyed).toBe(true);
  });

  it("writes 403", () => {
    const writes: string[] = [];
    rejectUpgrade(
      { write: (s: string) => writes.push(s), destroy: () => {} },
      403,
      "Forbidden",
    );
    expect(writes[0]).toMatch(/^HTTP\/1\.1 403/);
  });
});
