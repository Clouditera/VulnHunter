/**
 * Credential advanced config section (fish 2026-08-08 终定, design doc
 * unified-credential-models-json-v1.0.md §3.1a; approved prototype v4).
 *
 * Collapsible「高级配置」inside the credential form — structured form first
 * (enum selects / toggles / cost fields), raw-JSON tab with two-way sync
 * + whitelist validation. (Level mapping retired fish 2026-08-09: single
 * send-value override lives in the main form.) Sparse
 * serialization: only non-default values persist; an all-default state
 * saves null (「使用默认配置」). Copy is pm-final (no pi/GLM mentions).
 */
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { i18n } from "../../../shared/i18n/index.js";

// ─── State shape & constants ───

export const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "together",
  "baseten",
  "deepseek",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
] as const;

export const MAX_TOKENS_FIELDS = ["max_completion_tokens", "max_tokens"] as const;

export interface AdvancedConfigState {
  thinkingFormat: string;
  maxTokensField: string;
  supportsReasoningEffort: boolean;
  supportsDeveloperRole: boolean;
  inputText: boolean;
  inputImage: boolean;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
}

/** fish 2026-08-08 默认值口径: 有通用默认的预填, 无通用默认的留空. */
export function defaultAdvancedConfig(): AdvancedConfigState {
  return {
    thinkingFormat: "openai",
    maxTokensField: "max_completion_tokens",
    supportsReasoningEffort: true,
    supportsDeveloperRole: true,
    inputText: true,
    inputImage: false,
    costInput: "",
    costOutput: "",
    costCacheRead: "",
    costCacheWrite: "",
  };
}

/** Load the 发送值 override from a credential (fish 2026-08-09 简化案).
 *  Legacy fallback: thinkingLevelValue absent AND a legacy thinkingLevelMap
 *  present → take the row of the CURRENT thinking_effort (string values
 *  only; null rows skipped) so yesterday's map-based credentials surface
 *  their translation instead of silently losing it on the next save
 *  (architect review 15864). Saving then writes thinkingLevelValue only —
 *  the legacy map key is not carried back (migration completes). */
export function loadThinkingOverride(c: {
  thinking_effort?: string;
  advanced_config?: Record<string, unknown> | null;
}): string {
  const cfg = c.advanced_config;
  if (!cfg || typeof cfg !== "object") return "";
  if (typeof cfg.thinkingLevelValue === "string") return cfg.thinkingLevelValue;
  const legacy = cfg.thinkingLevelMap;
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const v = (legacy as Record<string, unknown>)[c.thinking_effort ?? ""];
    if (typeof v === "string") return v;
  }
  return "";
}

// ─── Parse (payload → form state) ───

export function parseAdvancedConfig(raw: unknown): AdvancedConfigState {
  const s = defaultAdvancedConfig();
  if (!raw || typeof raw !== "object") return s;
  const cfg = raw as Record<string, unknown>;
  const compat = (cfg.compat ?? {}) as Record<string, unknown>;
  if (typeof compat.thinkingFormat === "string" && (THINKING_FORMATS as readonly string[]).includes(compat.thinkingFormat))
    s.thinkingFormat = compat.thinkingFormat;
  if (typeof compat.maxTokensField === "string" && (MAX_TOKENS_FIELDS as readonly string[]).includes(compat.maxTokensField))
    s.maxTokensField = compat.maxTokensField;
  if (typeof compat.supportsReasoningEffort === "boolean") s.supportsReasoningEffort = compat.supportsReasoningEffort;
  if (typeof compat.supportsDeveloperRole === "boolean") s.supportsDeveloperRole = compat.supportsDeveloperRole;
  if (Array.isArray(cfg.input)) {
    const arr = cfg.input.filter((x): x is string => typeof x === "string");
    s.inputText = arr.includes("text");
    s.inputImage = arr.includes("image");
  }
  const cost = (cfg.cost ?? {}) as Record<string, unknown>;
  for (const [key, setter] of [
    ["input", (v: string) => (s.costInput = v)],
    ["output", (v: string) => (s.costOutput = v)],
    ["cacheRead", (v: string) => (s.costCacheRead = v)],
    ["cacheWrite", (v: string) => (s.costCacheWrite = v)],
  ] as Array<[string, (v: string) => void]>) {
    const v = cost[key];
    if (typeof v === "number" && Number.isFinite(v)) setter(String(v));
  }
  return s;
}

// ─── Serialize (form state → sparse payload; null = all default) ───

export function serializeAdvancedConfig(s: AdvancedConfigState): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const compat: Record<string, unknown> = {};
  if (s.thinkingFormat !== "openai") compat.thinkingFormat = s.thinkingFormat;
  if (s.maxTokensField !== "max_completion_tokens") compat.maxTokensField = s.maxTokensField;
  if (!s.supportsReasoningEffort) compat.supportsReasoningEffort = false;
  if (!s.supportsDeveloperRole) compat.supportsDeveloperRole = false;
  if (Object.keys(compat).length > 0) out.compat = compat;

  const input: string[] = [];
  if (s.inputText) input.push("text");
  if (s.inputImage) input.push("image");
  if (!(input.length === 1 && input[0] === "text")) out.input = input;

  const cost: Record<string, number> = {};
  for (const [key, raw] of [
    ["input", s.costInput],
    ["output", s.costOutput],
    ["cacheRead", s.costCacheRead],
    ["cacheWrite", s.costCacheWrite],
  ] as Array<[string, string]>) {
    const t = raw.trim();
    if (t === "") continue;
    const n = Number(t);
    if (Number.isFinite(n)) cost[key] = n;
  }
  if (Object.keys(cost).length > 0) out.cost = cost;

  return Object.keys(out).length > 0 ? out : null;
}

/** Number of customized (non-default) items — for the「已定制 N 项」summary. */
export function countCustomized(s: AdvancedConfigState): number {
  let n = 0;
  if (s.thinkingFormat !== "openai") n++;
  if (s.maxTokensField !== "max_completion_tokens") n++;
  if (!s.supportsReasoningEffort) n++;
  if (!s.supportsDeveloperRole) n++;
  if (!(s.inputText && !s.inputImage)) n++;
  if (s.costInput.trim() !== "") n++;
  if (s.costOutput.trim() !== "") n++;
  if (s.costCacheRead.trim() !== "") n++;
  if (s.costCacheWrite.trim() !== "") n++;
  return n;
}

// ─── Raw-JSON validation (whitelist) ───

const JSON_TOP_KEYS = new Set(["compat", "input", "cost", "thinkingLevelValue"]);
const JSON_COMPAT_KEYS = new Set([
  "supportsDeveloperRole",
  "thinkingFormat",
  "supportsReasoningEffort",
  "maxTokensField",
]);

/** Returns an error i18n key (+detail) or null when the parsed JSON is a
 *  valid advanced_config shape. */
export function validateAdvancedJson(text: string): { key: string; detail?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { key: "settings.adv.json.err.syntax" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { key: "settings.adv.json.err.shape" };
  const cfg = parsed as Record<string, unknown>;
  for (const k of Object.keys(cfg)) {
    if (!JSON_TOP_KEYS.has(k)) return { key: "settings.adv.json.err.unknownKey", detail: k };
  }
  if (cfg.compat !== undefined) {
    if (!cfg.compat || typeof cfg.compat !== "object" || Array.isArray(cfg.compat))
      return { key: "settings.adv.json.err.compatShape" };
    for (const [k, v] of Object.entries(cfg.compat as Record<string, unknown>)) {
      if (!JSON_COMPAT_KEYS.has(k)) return { key: "settings.adv.json.err.unknownKey", detail: `compat.${k}` };
      if (k === "thinkingFormat" && !(THINKING_FORMATS as readonly string[]).includes(v as string))
        return { key: "settings.adv.json.err.thinkingFormat" };
      if (k === "maxTokensField" && !(MAX_TOKENS_FIELDS as readonly string[]).includes(v as string))
        return { key: "settings.adv.json.err.maxTokensField" };
      if ((k === "supportsDeveloperRole" || k === "supportsReasoningEffort") && typeof v !== "boolean")
        return { key: "settings.adv.json.err.boolean", detail: `compat.${k}` };
    }
  }
  if (cfg.thinkingLevelValue !== undefined && typeof cfg.thinkingLevelValue !== "string")
    return { key: "settings.adv.json.err.levelValue" };
  if (cfg.input !== undefined) {
    if (!Array.isArray(cfg.input) || cfg.input.some((x) => x !== "text" && x !== "image"))
      return { key: "settings.adv.json.err.inputShape" };
  }
  if (cfg.cost !== undefined) {
    if (!cfg.cost || typeof cfg.cost !== "object" || Array.isArray(cfg.cost))
      return { key: "settings.adv.json.err.costShape" };
    for (const [k, v] of Object.entries(cfg.cost as Record<string, unknown>)) {
      if (!["input", "output", "cacheRead", "cacheWrite"].includes(k))
        return { key: "settings.adv.json.err.unknownKey", detail: `cost.${k}` };
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        return { key: "settings.adv.json.err.costValue", detail: k };
    }
  }
  return null;
}

// ─── Component ───

const LABEL: CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: "6px",
  letterSpacing: "0.04em",
};
const INPUT: CSSProperties = {
  display: "block",
  width: "100%",
  height: "40px",
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  fontSize: "14px",
  color: "var(--text-primary)",
  background: "var(--bg-card)",
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};
const HINT: CSSProperties = { fontSize: "11px", color: "var(--text-tertiary)", marginTop: "4px", lineHeight: 1.5 };
const SUBSEC: CSSProperties = {
  fontSize: "10.5px",
  fontWeight: 700,
  color: "var(--text-tertiary)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  margin: "16px 0 10px",
};

function Toggle(props: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; testid?: string }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
      style={{
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        border: "none",
        cursor: props.disabled ? "not-allowed" : "pointer",
        background: props.on ? "var(--brand)" : "var(--border)",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "2px",
          left: props.on ? "18px" : "2px",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

export function CredentialAdvancedConfig(props: {
  value: AdvancedConfigState;
  onChange: (next: AdvancedConfigState) => void;
  /** Baseline (loaded-from-server) state — fields differing from it get the
   *  "just modified, retest" marker (fish: 高级配置变更=核心变更). */
  baseline?: AdvancedConfigState | null;
  disabled?: boolean;
}) {
  const { value, onChange, baseline, disabled } = props;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"structured" | "json">("structured");
  const [jsonText, setJsonText] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);

  const customized = countCustomized(value);
  const serializedString = useMemo(() => JSON.stringify(serializeAdvancedConfig(value)), [value]);
  const baselineString = useMemo(
    () => JSON.stringify(serializeAdvancedConfig(baseline ?? defaultAdvancedConfig())),
    [baseline],
  );
  const hasUntestedChanges = serializedString !== baselineString;

  const jsonError = tab === "json" ? validateAdvancedJson(jsonText) : null;

  function patch(p: Partial<AdvancedConfigState>) {
    onChange({ ...value, ...p });
  }
  function switchTab(next: "structured" | "json") {
    if (next === "json") {
      // Structured → JSON: seed the editor from the current (sparse) config.
      const ser = serializeAdvancedConfig(value);
      setJsonText(ser ? JSON.stringify(ser, null, 2) : "{}");
      setJsonDirty(false);
    }
    setTab(next);
  }
  function handleJsonEdit(text: string) {
    setJsonText(text);
    const err = validateAdvancedJson(text);
    if (err) return; // 非法 JSON 不落表单（pm 定稿容错），仅内联报错
    onChange(parseAdvancedConfig(JSON.parse(text)));
    setJsonDirty(true);
  }

  const modified = (field: keyof Pick<AdvancedConfigState, "thinkingFormat" | "maxTokensField">) =>
    baseline != null && value[field] !== baseline[field];
  const modifiedStyle = (on: boolean): CSSProperties | undefined =>
    on ? { borderColor: "var(--sev-medium)" } : undefined;

  return (
    <div
      data-testid="settings-adv-section"
      style={{ border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden", marginBottom: "4px" }}
    >
      <div
        data-testid="settings-adv-toggle"
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "11px 12px",
          cursor: "pointer",
          userSelect: "none",
          background: "var(--bg-header)",
        }}
      >
        <span
          style={{
            fontSize: "9px",
            color: "var(--text-secondary)",
            transition: "transform 0.15s",
            width: "10px",
            transform: open ? "rotate(90deg)" : undefined,
          }}
        >
          ▶
        </span>
        <span style={{ fontSize: "12px", fontWeight: 600 }}>{i18n.t("settings.adv.title")}</span>
        <span
          data-testid="settings-adv-summary"
          style={{
            marginLeft: "auto",
            fontSize: "11px",
            color: customized > 0 ? "var(--brand)" : "var(--text-tertiary)",
            fontWeight: customized > 0 ? 600 : 400,
          }}
        >
          {customized > 0
            ? hasUntestedChanges
              ? i18n.t("settings.adv.summary.customizedDirty").replace("{n}", String(customized))
              : i18n.t("settings.adv.summary.customized").replace("{n}", String(customized))
            : i18n.t("settings.adv.summary.default")}
        </span>
      </div>

      {open && (
        <div style={{ borderTop: "1px solid var(--divider)", padding: "14px 12px" }}>
          <div
            style={{
              display: "inline-flex",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              overflow: "hidden",
              marginBottom: "14px",
            }}
          >
            {(["structured", "json"] as const).map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`settings-adv-tab-${k}`}
                onClick={() => switchTab(k)}
                style={{
                  padding: "5px 14px",
                  fontSize: "11.5px",
                  border: "none",
                  background: tab === k ? "var(--bg-active-filter)" : "var(--bg-card)",
                  color: tab === k ? "var(--brand)" : "var(--text-secondary)",
                  fontWeight: tab === k ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                {k === "structured" ? i18n.t("settings.adv.tab.structured") : i18n.t("settings.adv.tab.json")}
              </button>
            ))}
          </div>

          {tab === "json" ? (
            <>
              <textarea
                data-testid="settings-adv-json"
                value={jsonText}
                onChange={(e) => handleJsonEdit(e.target.value)}
                spellCheck={false}
                style={{
                  width: "100%",
                  minHeight: "210px",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  padding: "12px",
                  fontFamily: "var(--font-mono)",
                  fontSize: "11.5px",
                  lineHeight: 1.7,
                  background: "var(--bg-page)",
                  color: "var(--text-primary)",
                  resize: "vertical",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--text-secondary)", marginTop: "8px" }}>
                ℹ {i18n.t("settings.adv.json.syncNote")}
              </div>
              {jsonError && (
                <div data-testid="settings-adv-json-error" style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11.5px", color: "var(--danger)", marginTop: "8px" }}>
                  ✕ {i18n.t(jsonError.key)}{jsonError.detail ? `：${jsonError.detail}` : ""}
                </div>
              )}
              {jsonDirty && !jsonError && (
                <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "8px" }}>
                  ✓ {i18n.t("settings.adv.json.applied")}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ ...SUBSEC, marginTop: 0 }}>{i18n.t("settings.adv.compat")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <span style={LABEL}>{i18n.t("settings.adv.thinkingFormat")}</span>
                  <select
                    data-testid="settings-adv-thinkingformat"
                    value={value.thinkingFormat}
                    disabled={disabled}
                    onChange={(e) => patch({ thinkingFormat: e.target.value })}
                    style={{ ...INPUT, ...modifiedStyle(modified("thinkingFormat")) }}
                  >
                    {THINKING_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f === "openai" ? i18n.t("settings.adv.format.default") : f}
                      </option>
                    ))}
                  </select>
                  <div style={{ ...HINT, ...(modified("thinkingFormat") ? { color: "var(--sev-medium)" } : {}) }}>
                    {modified("thinkingFormat")
                      ? i18n.t("settings.adv.justModified")
                      : i18n.t("settings.adv.thinkingFormat.hint")}
                  </div>
                </div>
                <div>
                  <span style={LABEL}>{i18n.t("settings.adv.maxTokensField")}</span>
                  <select
                    data-testid="settings-adv-maxtokensfield"
                    value={value.maxTokensField}
                    disabled={disabled}
                    onChange={(e) => patch({ maxTokensField: e.target.value })}
                    style={{ ...INPUT, ...modifiedStyle(modified("maxTokensField")) }}
                  >
                    {MAX_TOKENS_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {f === "max_completion_tokens" ? `${f}（${i18n.t("settings.adv.defaultMark")}）` : f}
                      </option>
                    ))}
                  </select>
                  <div style={{ ...HINT, ...(modified("maxTokensField") ? { color: "var(--sev-medium)" } : {}) }}>
                    {modified("maxTokensField")
                      ? i18n.t("settings.adv.justModified")
                      : i18n.t("settings.adv.maxTokensField.hint")}
                  </div>
                </div>
              </div>

              {(
                [
                  ["supportsReasoningEffort", "settings.adv.reasoningEffort.desc", "settings-adv-reasoningeffort"],
                  ["supportsDeveloperRole", "settings.adv.developerRole.desc", "settings-adv-developerrole"],
                ] as const
              ).map(([key, descKey, testid]) => (
                <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "12.5px", fontFamily: "var(--font-mono)" }}>{key}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-tertiary)", marginTop: "2px" }}>
                      {i18n.t(descKey)}
                    </div>
                  </div>
                  <Toggle
                    testid={testid}
                    on={value[key]}
                    disabled={disabled}
                    onChange={(v) => patch({ [key]: v } as Partial<AdvancedConfigState>)}
                  />
                </div>
              ))}

              <div style={SUBSEC}>{i18n.t("settings.adv.input")}</div>
              <div style={{ display: "flex", gap: "16px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", cursor: "pointer" }}>
                  <input
                    data-testid="settings-adv-input-text"
                    type="checkbox"
                    checked={value.inputText}
                    disabled={disabled || (!value.inputImage && value.inputText)}
                    onChange={(e) => patch({ inputText: e.target.checked })}
                    style={{ accentColor: "var(--brand)" }}
                  />
                  text
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12.5px", cursor: "pointer" }}>
                  <input
                    data-testid="settings-adv-input-image"
                    type="checkbox"
                    checked={value.inputImage}
                    disabled={disabled}
                    onChange={(e) => patch({ inputImage: e.target.checked })}
                    style={{ accentColor: "var(--brand)" }}
                  />
                  {i18n.t("settings.adv.input.image")}
                </label>
              </div>
              <div style={{ ...HINT, marginTop: "6px" }}>{i18n.t("settings.adv.input.hint")}</div>

              <div style={SUBSEC}>{i18n.t("settings.adv.cost")}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                {(
                  [
                    ["costInput", "input", "settings-adv-cost-input"],
                    ["costOutput", "output", "settings-adv-cost-output"],
                    ["costCacheRead", "cacheRead", "settings-adv-cost-cacheread"],
                    ["costCacheWrite", "cacheWrite", "settings-adv-cost-cachewrite"],
                  ] as const
                ).map(([key, label, testid]) => (
                  <div key={key}>
                    <span style={LABEL}>{label}</span>
                    <input
                      data-testid={testid}
                      value={value[key]}
                      disabled={disabled}
                      inputMode="decimal"
                      onChange={(e) => patch({ [key]: e.target.value } as Partial<AdvancedConfigState>)}
                      style={INPUT}
                    />
                  </div>
                ))}
              </div>

              
            </>
          )}
        </div>
      )}
    </div>
  );
}
