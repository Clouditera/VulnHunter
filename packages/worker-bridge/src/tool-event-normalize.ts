/**
 * Normalize pi tool events into the platform-agreed schema.
 *
 * pi emits tool_execution_start/end with camelCase fields:
 *   { type, toolCallId, toolName, result: { content: [{ type:"text", text }] }, isError }
 * The platform frontend reducer + service persistence expect:
 *   { type, tool_call_id, tool, result: <string>, error }
 *
 * Doing this once at the bridge stdout boundary means the frontend and service
 * read a single consistent shape — instead of each guessing field names.
 */

/**
 * Extract a plain string from a pi tool `result`, which may be:
 *   - a string (already flat)
 *   - an object `{ content: [{ type: "text", text }] }` (pi tool-result shape)
 *   - undefined
 * For present-artifact the inner text is the `{type:"chat_artifact",...}` JSON
 * the frontend needs to parse, so flattening it into `result` is what lets the
 * artifact card render.
 */
export function flattenToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((b) =>
          b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
            ? (b as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    try { return JSON.stringify(result); } catch { return undefined; }
  }
  return String(result);
}

/**
 * Normalize a pi stdout JSONL line. For tool_execution_start/end events, map
 * pi's camelCase fields to the platform schema. All other lines are returned
 * unchanged. Never throws — falls back to the original line on parse error.
 */
export function normalizeToolEventLine(line: string): string {
  let evt: Record<string, unknown>;
  try { evt = JSON.parse(line); } catch { return line; }
  const type = evt.type;
  if (type !== "tool_execution_start" && type !== "tool_execution_end") return line;

  const norm: Record<string, unknown> = { ...evt };
  norm.tool_call_id = evt.tool_call_id ?? evt.toolCallId;
  norm.tool = evt.tool ?? evt.toolName ?? evt.tool_name ?? evt.name;
  if (type === "tool_execution_end") {
    norm.result = flattenToolResult(evt.result ?? evt.result_summary);
    const err = evt.error ?? evt.isError;
    norm.error = typeof err === "string" ? err : err ? "error" : undefined;
  }
  try { return JSON.stringify(norm); } catch { return line; }
}
