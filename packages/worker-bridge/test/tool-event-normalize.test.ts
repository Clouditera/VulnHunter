import { describe, expect, it } from "vitest";
import { flattenToolResult, normalizeToolEventLine } from "../src/tool-event-normalize.js";

describe("flattenToolResult", () => {
  it("returns strings unchanged", () => {
    expect(flattenToolResult("hello")).toBe("hello");
  });
  it("extracts text from pi { content: [{text}] } shape", () => {
    expect(flattenToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });
  it("returns undefined for null/undefined", () => {
    expect(flattenToolResult(undefined)).toBeUndefined();
    expect(flattenToolResult(null)).toBeUndefined();
  });
  it("preserves present-artifact chat_artifact JSON in inner text", () => {
    const artifactJson = JSON.stringify({ type: "chat_artifact", artifact_id: "a1", kind: "presented" });
    const out = flattenToolResult({ content: [{ type: "text", text: artifactJson }] });
    expect(out).toBe(artifactJson);
    expect(JSON.parse(out!).type).toBe("chat_artifact");
  });
});

describe("normalizeToolEventLine", () => {
  it("maps pi camelCase tool_execution_end to platform schema", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "present-artifact",
      result: { content: [{ type: "text", text: "{\"type\":\"chat_artifact\"}" }] },
      isError: false,
    });
    const out = JSON.parse(normalizeToolEventLine(line));
    expect(out.tool_call_id).toBe("tc-1");
    expect(out.tool).toBe("present-artifact");
    expect(out.result).toBe('{"type":"chat_artifact"}');
    expect(out.error).toBeUndefined();
  });

  it("maps tool_execution_start id + name", () => {
    const line = JSON.stringify({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "create-task" });
    const out = JSON.parse(normalizeToolEventLine(line));
    expect(out.tool_call_id).toBe("tc-2");
    expect(out.tool).toBe("create-task");
  });

  it("sets error string when isError true", () => {
    const line = JSON.stringify({ type: "tool_execution_end", toolCallId: "tc-3", toolName: "x", isError: true });
    const out = JSON.parse(normalizeToolEventLine(line));
    expect(out.error).toBe("error");
  });

  it("passes non-tool events through unchanged", () => {
    const line = JSON.stringify({ type: "message_start", message: { role: "assistant" } });
    expect(normalizeToolEventLine(line)).toBe(line);
  });

  it("returns invalid JSON unchanged without throwing", () => {
    expect(normalizeToolEventLine("not json")).toBe("not json");
  });
});
