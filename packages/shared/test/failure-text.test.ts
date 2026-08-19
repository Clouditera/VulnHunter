import { describe, expect, it } from "vitest";
import { parseStructuredFailure, sanitizeErrorText } from "../src/errors/index.js";

// Screenshot payload from HALL-4: youngflow engine embeds Docker stdcopy
// multiplexed-log frame header bytes (stream type + 3 pad + 4-byte BE length)
// directly into the reported error message.
const DOCKER_FRAME_PREFIX = "\u0002\u0000\u0000\u0000\u0000\u0000\u0000000";
const SCREENSHOT_PAYLOAD = JSON.stringify({
  code: "ERR_PREPARE_FAILED",
  message: `Prepare 失败 (退出码 4): ${DOCKER_FRAME_PREFIX}02:57:41 [youngflow.runner] ERROR [prepare] ✕ API error (1): 403: {"code":"no_default_group","message":"no default group available for this model"}`,
  details: { engineError: "exit code 4" },
});
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D]/;

describe("sanitizeErrorText", () => {
  it("strips Docker stdcopy frame-header control bytes", () => {
    const out = sanitizeErrorText(SCREENSHOT_PAYLOAD);
    expect(out).not.toMatch(CONTROL_CHAR_RE);
    expect(out).toContain("Prepare 失败 (退出码 4)");
    expect(out).toContain("no default group available for this model");
  });

  it("keeps Chinese, emoji, newline and tab intact", () => {
    const input = "第一行：扫描失败 ❌\n\t第二行 emoji 🚀 保留";
    expect(sanitizeErrorText(input)).toBe(input);
  });

  it("strips ANSI escape sequences before control chars", () => {
    expect(sanitizeErrorText("\u001B[31m红色报错\u001B[0m")).toBe("红色报错");
  });

  it("removes BOM and zero-width characters", () => {
    expect(sanitizeErrorText("\uFEFF前\u200B零宽\u200D后")).toBe("前零宽后");
  });

  it("truncates overlong input and appends the truncation marker", () => {
    const out = sanitizeErrorText("a".repeat(5000));
    expect(out.endsWith("…（已截断）")).toBe(true);
    expect(out.length).toBe(4000 + "…（已截断）".length);
  });

  it("honours a custom maxLen", () => {
    expect(sanitizeErrorText("abcdef", 3)).toBe("abc…（已截断）");
  });

  it("returns short input unchanged", () => {
    expect(sanitizeErrorText("ok")).toBe("ok");
  });
});

describe("parseStructuredFailure", () => {
  it("parses the screenshot payload into code/message/details", () => {
    const parsed = parseStructuredFailure(sanitizeErrorText(SCREENSHOT_PAYLOAD));
    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe("ERR_PREPARE_FAILED");
    expect(parsed?.message).toContain("Prepare 失败");
    expect(parsed?.message).toContain("no default group available for this model");
    expect(parsed?.details).toEqual({ engineError: "exit code 4" });
  });

  it("returns null for plain legacy text", () => {
    expect(parseStructuredFailure("Prepare 失败 (退出码 4)")).toBeNull();
  });

  it("returns null for JSON without a string code field", () => {
    expect(parseStructuredFailure('{"message":"oops"}')).toBeNull();
    expect(parseStructuredFailure('{"code":42,"message":"oops"}')).toBeNull();
    expect(parseStructuredFailure('["ERR_X"]')).toBeNull();
  });

  it("returns null for truncated / malformed JSON", () => {
    expect(parseStructuredFailure('{"code":"ERR_X","message":"unterminated')).toBeNull();
  });

  it("tolerates a missing message field", () => {
    const parsed = parseStructuredFailure('{"code":"ERR_INTERNAL"}');
    expect(parsed).toEqual({ code: "ERR_INTERNAL", message: "", details: undefined });
  });
});
