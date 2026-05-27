import { describe, expect, it } from "vitest";
import { isDefaultChatTitle, sanitizeGeneratedTitle } from "../../src/features/chat/title-generation.js";

describe("chat title generation helpers", () => {
  it("recognizes only default titles as replaceable", () => {
    expect(isDefaultChatTitle("New Chat")).toBe(true);
    expect(isDefaultChatTitle("新对话")).toBe(true);
    expect(isDefaultChatTitle(" ")).toBe(true);
    expect(isDefaultChatTitle("第三方系统 H2 RCE 复现")).toBe(false);
  });

  it("cleans generated titles", () => {
    expect(sanitizeGeneratedTitle("标题：\"模型 Token 用量分析。\"\n"))
      .toBe("模型 Token 用量分析");
    expect(sanitizeGeneratedTitle("Redis 扫描结果对比以及后续分析计划需要继续解释").length)
      .toBeLessThanOrEqual(20);
  });
});
