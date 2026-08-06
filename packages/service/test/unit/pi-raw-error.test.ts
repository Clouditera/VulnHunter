import { describe, expect, it } from "vitest";

/**
 * Raw network error formatting for diagnostic failure rows (fish 2026-08-06):
 * no human classification, no fix suggestions — just the raw error, with the
 * API key scrubbed and a hard ~200 char truncation.
 */

const { formatRawError } = await import("../../src/features/settings/pi-diagnostics.js");

describe("formatRawError (fish: raw network error in failure rows)", () => {
  it("composes HTTP status + gateway body when a status is present", () => {
    expect(formatRawError('{"error":{"message":"Model Not Exist"}}', 400, "sk-x"))
      .toBe('HTTP 400 — {"error":{"message":"Model Not Exist"}}');
  });

  it("does not double-prefix when the message already carries HTTP", () => {
    expect(formatRawError("HTTP 401 — Authentication Fails", 401, "sk-x"))
      .toBe("HTTP 401 — Authentication Fails");
  });

  it("passes network-layer causes verbatim (no status)", () => {
    expect(formatRawError("getaddrinfo ENOTFOUND api.typo-host.com", undefined, "sk-x"))
      .toBe("getaddrinfo ENOTFOUND api.typo-host.com");
    expect(formatRawError("connect ECONNREFUSED 127.0.0.1:29999", undefined, "sk-x"))
      .toBe("connect ECONNREFUSED 127.0.0.1:29999");
    expect(formatRawError("basic timeout (15000ms)", undefined, "sk-x"))
      .toBe("basic timeout (15000ms)");
  });

  it("scrubs the plain API key from the message (safety gate)", () => {
    const msg = formatRawError('Your api key: sk-secret-123 is invalid', 401, "sk-secret-123");
    expect(msg).not.toContain("sk-secret-123");
    expect(msg).toContain("Your api key: *** is invalid");
  });

  it("truncates at ~200 chars with ellipsis", () => {
    const long = "x".repeat(500);
    const out = formatRawError(long, undefined, "sk-x");
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
  });
});
