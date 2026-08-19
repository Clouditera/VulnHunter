/**
 * Boundary sanitizing for user-visible error text (HALL-4).
 *
 * Anything crossing the engine → platform boundary may carry raw terminal
 * bytes — e.g. youngflow currently embeds Docker stdcopy multiplexed-log
 * frame headers (`\u0002\u0000…`) straight into reported error messages.
 * `sanitizeErrorText` is the single choke point both sides reuse:
 * service sanitizes before persisting `tasks.failure_reason`, web sanitizes
 * again before rendering (defence in depth + legacy dirty rows).
 */

/**
 * Strip ANSI escape sequences, C0/C1 control characters (keeping `\n`/`\t`),
 * DEL, BOM and zero-width characters, then cap length.
 *
 * Kept: every printable Unicode codepoint (Chinese, emoji, …), `\n`, `\t`.
 */
export function sanitizeErrorText(raw: string, maxLen = 4000): string {
  const cleaned = raw
    // ANSI CSI / single-char escape sequences first, so their printable
    // remainder ("[31m") does not survive the control-char pass.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires control chars
    .replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point of this util
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D]/g, "");
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}…（已截断）`;
}

/** Structured failure payload the engine reports as failure_reason JSON. */
export interface StructuredFailure {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Parse a failure_reason string into its structured form. Returns null unless
 * the text is JSON whose top level is an object with a string `code` — every
 * other shape (legacy plain text, truncated JSON, arrays) stays plain text.
 */
export function parseStructuredFailure(raw: string): StructuredFailure | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof obj.code !== "string") return null;
  return {
    code: obj.code,
    message: typeof obj.message === "string" ? obj.message : "",
    details: obj.details,
  };
}
