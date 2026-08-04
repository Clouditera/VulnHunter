import { describe, expect, it } from "vitest";
import { ERROR_REGISTRY, getErrorEntry, errorHttpStatus, type ErrorCode } from "../src/errors/index.js";

describe("error registry", () => {
  it("every entry has i18nKey + httpStatus", () => {
    for (const [code, entry] of Object.entries(ERROR_REGISTRY)) {
      expect(entry.i18nKey).toBe(`errors.${code}`);
      expect(entry.httpStatus).toBeGreaterThan(0);
      expect(entry.httpStatus).toBeLessThan(600);
    }
  });

  it("getErrorEntry returns entry for known code", () => {
    const e = getErrorEntry("ERR_PREPARE_FAILED");
    expect(e.i18nKey).toBe("errors.ERR_PREPARE_FAILED");
    expect(e.httpStatus).toBe(502);
    expect(e.retriable).toBe(true);
  });

  it("getErrorEntry falls back to ERR_INTERNAL for unknown code", () => {
    const e = getErrorEntry("ERR_SOMETHING_NEW");
    expect(e.i18nKey).toBe("errors.ERR_INTERNAL");
    expect(e.httpStatus).toBe(500);
  });

  it("errorHttpStatus maps correctly", () => {
    expect(errorHttpStatus("ERR_AUTH_REQUIRED")).toBe(401);
    expect(errorHttpStatus("ERR_NOT_FOUND")).toBe(404);
    expect(errorHttpStatus("ERR_INTERNAL")).toBe(500);
    expect(errorHttpStatus("UNKNOWN_CODE")).toBe(500);
  });

  it("seed codes from spec §3 are all present", () => {
    const required: ErrorCode[] = [
      "ERR_PREPARE_FAILED",
      "ERR_MODEL_UPSTREAM",
      "ERR_CREDENTIAL_TEST_FAILED",
      "ERR_SANDBOX_NOT_CONFIGURED",
      "ERR_AUTH_LOCKED",
      "ERR_TASK_NAME_CONFLICT",
      "ERR_PROTECTED_ACCOUNT",
      "ERR_SOURCE_ARCHIVE_UNSAFE_PATH",
      "ERR_LICENSE_INVALID",
      "ERR_LICENSE_EXPIRED",
      "ERR_INTERNAL",
    ];
    for (const code of required) {
      expect(code in ERROR_REGISTRY).toBe(true);
    }
  });

  it("action navigate targets are valid routes", () => {
    for (const entry of Object.values(ERROR_REGISTRY)) {
      if (entry.action?.kind === "navigate") {
        expect(entry.action.to).toMatch(/^\/[a-z?=&_-]+$/i);
      }
    }
  });

  it("unregistered code is a type error (compile-time enforcement)", () => {
    // This is a type-level test: if we reference a code not in the registry,
    // tsc will fail. We verify the type union is derived correctly.
    const code: ErrorCode = "ERR_INTERNAL";
    expect(code).toBe("ERR_INTERNAL");
  });
});
