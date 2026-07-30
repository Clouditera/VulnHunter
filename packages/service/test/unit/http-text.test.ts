import { describe, it, expect } from "vitest";
import { isTextualMime, withUtf8Charset } from "../../src/infra/http-text.js";

describe("withUtf8Charset", () => {
  it("appends charset", () => {
    expect(withUtf8Charset("text/plain")).toBe("text/plain; charset=utf-8");
    expect(withUtf8Charset("text/markdown")).toBe("text/markdown; charset=utf-8");
  });
  it("keeps existing charset", () => {
    expect(withUtf8Charset("text/plain; charset=gbk")).toBe("text/plain; charset=gbk");
  });
});

describe("isTextualMime", () => {
  it("detects text families", () => {
    expect(isTextualMime("text/plain")).toBe(true);
    expect(isTextualMime("application/json")).toBe(true);
    expect(isTextualMime("application/pdf")).toBe(false);
  });
});
