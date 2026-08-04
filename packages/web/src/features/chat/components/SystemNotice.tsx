/**
 * SystemNotice — chat error/system line (task-d9b94859, fish 2026-08-04).
 *
 * Errors are NOT agent replies. They render as a low-key system notice in
 * the message stream: small, grey, italic, no avatar, no bubble — matching
 * fish's reference (Member "x" request failed…). Persisted server-side as
 * role="system" messages so they survive page switches.
 *
 * Humanization: raw stored lines look like `ERR_INTERNAL: Bridge WS
 * connection timeout (10s)`. When the leading code has an `errors.<code>`
 * registry entry we lead with the human text and keep the raw detail as a
 * subdued mono suffix (三层语义: 人话 + code 可核对); otherwise the raw line
 * renders as-is.
 */
import { i18n } from "../../../shared/i18n/index.js";

/** Split `ERR_CODE: detail` (also matches bare `ERR_CODE` and legacy `Error: …`). */
export function splitErrorCode(raw: string): { code: string | null; detail: string } {
  const m = raw.match(/^(ERR_[A-Z0-9_]+):?\s*(.*)$/);
  if (m) return { code: m[1], detail: m[2] ?? "" };
  return { code: null, detail: raw };
}

/** Resolve the human line for a chat error (registry → i18n-key passthrough
 *  → special cases → raw). */
export function humanizeChatError(raw: string): { human: string; code: string | null; detail: string } {
  // i18n-key sentinel (client-generated notices, e.g. chat.error.wsClosed)
  if (/^chat\.error\.[a-zA-Z]+$/.test(raw)) {
    const translated = i18n.t(raw);
    if (translated && translated !== raw) return { human: translated, code: null, detail: "" };
  }
  const { code, detail } = splitErrorCode(raw);
  if (code) {
    const key = `errors.${code}`;
    const translated = i18n.t(key);
    if (translated && translated !== key) return { human: translated, code, detail };
  }
  if (raw.includes("ERR_NO_LLM_CREDENTIAL") || raw.includes("没有可用模型凭证") || raw.includes("请先配置")) {
    return { human: i18n.t("chat.error.noCredential"), code, detail };
  }
  if (raw.includes("VULNHUNTER_MASTER_KEY_FILE") || raw.includes("凭证加密 key 未配置")) {
    return { human: i18n.t("chat.error.masterKey"), code, detail };
  }
  if (raw.includes("无法解密") || raw.includes("cannot be decrypted")) {
    return { human: i18n.t("chat.error.decrypt"), code, detail };
  }
  return { human: raw, code, detail };
}

export function SystemNotice({ content, testid }: { content: string; testid?: string }) {
  const { human, code, detail } = humanizeChatError(content);
  const showRawSuffix = code != null && human !== content;
  return (
    <div
      data-testid={testid ?? "chat-system-notice"}
      style={{
        padding: "2px 4px",
        fontSize: "12px",
        lineHeight: 1.6,
        color: "var(--text-tertiary, var(--text-secondary))",
        fontStyle: "italic",
        wordBreak: "break-word",
      }}
    >
      <span>{human}</span>
      {showRawSuffix ? (
        <span
          style={{
            marginLeft: "8px",
            fontStyle: "normal",
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            fontSize: "11px",
            opacity: 0.75,
          }}
        >
          {code}{detail ? `: ${detail}` : ""}
        </span>
      ) : null}
    </div>
  );
}
