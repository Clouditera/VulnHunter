import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import type { SystemStatus } from "@vulnagent/shared";
import { i18n } from "../../../shared/i18n/index.js";
import { theme as themeStore } from "../../../shared/theme/index.js";
import { Icon, type IconName } from "../../../shared/components/Icon.js";
import { api, type LlmCredential, type SystemConfig } from "../../../shared/api/client.js";
import { SkillsSection } from "../components/SkillsSection.js";
import { PocSettingsSection } from "../components/PocSettingsSection.js";
import { UsersSection } from "../components/UsersSection.js";
import { ProfileSection } from "../components/ProfileSection.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";

/* -------------------------------------------------------------------------- */
/*  Design tokens mirroring the prototype.                                    */
/* -------------------------------------------------------------------------- */

const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "24px",
  marginBottom: "16px",
};

const FIELD_LABEL: CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: "6px",
  letterSpacing: "0.04em",
};

const FIELD_INPUT: CSSProperties = {
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
  transition: "border-color 0.15s",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const FIELD_HINT: CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  marginTop: "4px",
  opacity: 0.85,
  margin: "4px 0 0",
};

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                     */
/* -------------------------------------------------------------------------- */

function SettingsCard({
  icon,
  title,
  desc,
  children,
  testid,
  actions,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: ReactNode;
  testid?: string;
  actions?: ReactNode;
}) {
  return (
    <section style={CARD} data-testid={testid}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
          marginBottom: "20px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontSize: "15px",
              fontWeight: 600,
              margin: "0 0 4px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              color: "var(--text-primary)",
            }}
          >
            <Icon
              name={icon}
              size={18}
              style={{ color: "var(--text-secondary)" }}
            />
            <span>{title}</span>
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--text-secondary)",
              opacity: 0.85,
              margin: 0,
            }}
          >
            {desc}
          </p>
        </div>
        {actions ? <div style={{ flexShrink: 0 }}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

const CRED_ROW_BTN: CSSProperties = {
  padding: "4px 10px",
  border: "1px solid var(--border)",
  borderRadius: "5px",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: "11px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function Field({
  label,
  hint,
  children,
}: {
  label?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "18px" }}>
      {label ? <label style={FIELD_LABEL}>{label}</label> : null}
      {children}
      {hint ? <p style={FIELD_HINT}>{hint}</p> : null}
    </div>
  );
}

function SegGroup<T extends string>({
  items,
  value,
  onChange,
  testid,
}: {
  items: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  testid?: string;
}) {
  return (
    <div
      role="radiogroup"
      data-testid={testid}
      style={{
        display: "inline-flex",
        gap: 0,
        border: "1px solid var(--border)",
        borderRadius: "8px",
        padding: "3px",
        background: "var(--bg-page)",
      }}
    >
      {items.map((it) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(it.value)}
            data-seg-value={it.value}
            data-active={active || undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 16px",
              fontSize: "13px",
              fontWeight: active ? 600 : 500,
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              background: active ? "var(--bg-card)" : "transparent",
              border: "none",
              borderRadius: "6px",
              cursor: "pointer",
              transition: "all 0.15s",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              lineHeight: 1,
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pure protocol type — this drives which API shape pi-cli/worker uses
 * when talking to the LLM endpoint. Changed from a provider abstraction
 * (anthropic/openai/minimax/custom) to 3 protocol options per Architect's
 * correction: pi's models.json `api` field must be one of these three
 * strings, otherwise endpoints like DeepSeek/mimo/kimi fail.
 */
const PROTOCOLS: ReadonlyArray<{
  value: string;
  labelKey: string;
  defaultModel: string;
}> = [
  {
    value: "openai-completions",
    labelKey: "settings.model.proto.openaiCompletions",
    defaultModel: "",
  },
  {
    value: "openai-responses",
    labelKey: "settings.model.proto.openaiResponses",
    defaultModel: "",
  },
  {
    value: "anthropic",
    labelKey: "settings.model.proto.anthropic",
    defaultModel: "",
  },
];

/**
 * Migration: old credentials stored proto_type as either "anthropic" or
 * "openai". Map them to the new 3-option scheme on load so the dropdown
 * always shows a valid selection.
 */
function normalizeProtoType(raw: string): string {
  if (raw === "openai") return "openai-completions"; // safer default for 3rd-party
  if (PROTOCOLS.some((p) => p.value === raw)) return raw;
  return "openai-completions";
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
function parseContextWindowInput(text: string): number | null {
  const raw = text.trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2];
  const tokens = Math.trunc(n * (unit === "m" ? 1000000 : unit === "k" ? 1000 : 1));
  return tokens >= 1000 && tokens <= 10000000 ? tokens : null;
}
function formatContextWindow(tokens?: number | null): string {
  const value = tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (value % 1000000 === 0) return `${value / 1000000}m`;
  if (value % 1000 === 0) return `${value / 1000}k`;
  return String(value);
}

const THINKING_VALUES = ["off", "minimal", "low", "medium", "high"] as const;
type ThinkingValue = (typeof THINKING_VALUES)[number];

function licenseStatusLabel(s: string | undefined): string {
  if (!s) return i18n.t("common.noData");
  return i18n.t(`settings.license.status.${s}`);
}

function licenseStatusColor(s: string | undefined): { bg: string; fg: string; dot: string } {
  switch (s) {
    case "active":
      return { bg: "var(--bg-success)", fg: "var(--bg-success-text)", dot: "#16a34a" };
    case "expired":
      return { bg: "var(--bg-error)", fg: "#991b1b", dot: "#dc2626" };
    case "invalid":
      return { bg: "var(--bg-error)", fg: "#991b1b", dot: "#dc2626" };
    default:
      return { bg: "var(--bg-warning)", fg: "#9a3412", dot: "#ea580c" };
  }
}

// Inject once: a simple keyframe animation the fetch/test buttons use
// while a network call is in flight. Scoped by a fixed id so hot-reload
// doesn't duplicate it.
function ensureSpinKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById("va-spin-keyframes")) return;
  const style = document.createElement("style");
  style.id = "va-spin-keyframes";
  style.textContent =
    "@keyframes va-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }";
  document.head.appendChild(style);
}

export function SettingsPage() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  useEffect(() => themeStore.onChange(() => force((n) => n + 1)), []);
  useEffect(() => ensureSpinKeyframes(), []);

  // Must be declared before any useEffect that references sysStatus
  const { data: sysStatus } = useSystemStatus();
  const isAdmin = sysStatus?.user?.role === "admin";

  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [cred, setCred] = useState<LlmCredential | null>(null);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [loading, setLoading] = useState(true);
  // Multi-credential support
  const [credentials, setCredentials] = useState<LlmCredential[]>([]);
  const [editingCredentialId, setEditingCredentialId] = useState<string | null>(null);
  /** True when the "+ New credential" draft row is visible and expanded. */
  const [isNewDraft, setIsNewDraft] = useState(false);
  const [label, setLabel] = useState<string>("");

  const [protoType, setProtoType] = useState<string>("openai-completions");
  const [baseUrl, setBaseUrl] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [thinking, setThinking] = useState<ThinkingValue>("medium");
  const [contextWindow, setContextWindow] = useState<string>("128k");
  const [apiKey, setApiKey] = useState<string>("");
  const [showKey, setShowKey] = useState(false);

  const [maxParallel, setMaxParallel] = useState<number>(3);
  const [youngflowMaxParallel, setYoungflowMaxParallel] = useState<number>(3);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Model enhancements
  const [modelOptions, setModelOptions] = useState<string[] | null>(null);
  const [modelFetchState, setModelFetchState] = useState<
    { kind: "idle" | "loading" } | { kind: "error"; msg: string }
  >({ kind: "idle" });
  const [testState, setTestState] = useState<
    { kind: "idle" | "loading"; diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult }
    | { kind: "ok"; msg?: string; diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult }
    | { kind: "err"; msg: string; diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult }
  >({ kind: "idle" });

  useEffect(() => {
    let mounted = true;
    const adminRole = sysStatus?.user?.role === "admin";
    const fetches: Promise<unknown>[] = [
      api.system.status().catch(() => null),
      api.settings.getCredential().catch(() => ({ credential: null as LlmCredential | null })),
      adminRole ? api.settings.getSystemConfig().catch(() => null as { config: SystemConfig } | null) : Promise.resolve(null),
      api.settings.listCredentials().catch(() => ({ credentials: [] as LlmCredential[] })),
    ];
    Promise.all(fetches).then(([s, credResp, cfg, credList]) => {
      if (!mounted) return;
      if (s) setStatus(s as typeof status);
      const cr = credResp as { credential: LlmCredential | null } | undefined;
      if (cr?.credential) {
        // Don't auto-expand — just store as reference for dirty checks
        setCred(cr.credential);
      }
      // Start with no credential expanded
      setEditingCredentialId(null);
      if (adminRole) {
        const cfgResp = cfg as { config: SystemConfig } | null | undefined;
        if (cfgResp?.config) {
          setConfig(cfgResp.config);
          setMaxParallel(cfgResp.config.max_parallel_scan);
          setYoungflowMaxParallel(cfgResp.config.youngflow_max_parallel ?? 3);
        }
      }
      const cl = credList as { credentials: LlmCredential[] } | undefined;
      if (cl?.credentials) {
        setCredentials(cl.credentials);
      }
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, [sysStatus?.user?.role]);

  /** Load a credential's values into the form for editing. */
  function editCredential(c: LlmCredential) {
    setCred(c);
    setEditingCredentialId(c.id);
    setIsNewDraft(false);
    setProtoType(normalizeProtoType(c.proto_type));
    setBaseUrl(c.base_url ?? "");
    setModelId(c.model_id);
    setThinking((c.thinking_effort as ThinkingValue) ?? "medium");
    setContextWindow(formatContextWindow(c.context_window_tokens));
    setLabel(c.label ?? "");
    setApiKey(""); // always require re-entry for security
    setTestState({ kind: "idle" });
    setToast(null);
  }

  /** Collapse the current expanded row (no draft, no editing). */
  function collapseExpanded() {
    setCred(null);
    setEditingCredentialId(null);
    setIsNewDraft(false);
    setApiKey("");
    setTestState({ kind: "idle" });
    setToast(null);
  }

  /** Open the "+ New credential" draft row at the top of the list. */
  function newCredential() {
    setCred(null);
    setEditingCredentialId(null);
    setIsNewDraft(true);
    const first = PROTOCOLS[0];
    setProtoType(first.value);
    setBaseUrl("");
    setModelId("");
    setThinking("medium");
    setContextWindow("128k");
    setLabel("");
    setApiKey("");
    setTestState({ kind: "idle" });
    setToast(null);
  }

  async function handleDeleteCredential(c: LlmCredential) {
    const msg = i18n
      .t("settings.credentials.deleteConfirm")
      .replace("{label}", c.label || c.provider);
    if (!window.confirm(msg)) return;
    try {
      await api.settings.deleteCredential(c.id);
      const fresh = await api.settings
        .listCredentials()
        .catch(() => ({ credentials: [] as LlmCredential[] }));
      setCredentials(fresh.credentials);
      if (editingCredentialId === c.id) {
        // If we just deleted the one being edited, reset form.
        newCredential();
        // Also refresh the "default" loaded credential.
        const cur = await api.settings
          .getCredential()
          .catch(() => ({ credential: null as LlmCredential | null }));
        if (cur?.credential) editCredential(cur.credential);
      }
      setToast({ kind: "ok", msg: i18n.t("settings.savedToast") });
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      setToast({ kind: "err", msg: String((err as Error).message || err) });
      setTimeout(() => setToast(null), 2800);
    }
  }

  async function handleSetDefault(c: LlmCredential) {
    try {
      await api.settings.setDefaultCredential(c.id);
      const fresh = await api.settings
        .listCredentials()
        .catch(() => ({ credentials: [] as LlmCredential[] }));
      setCredentials(fresh.credentials);
      setToast({ kind: "ok", msg: i18n.t("settings.savedToast") });
      setTimeout(() => setToast(null), 2000);
    } catch (err) {
      setToast({ kind: "err", msg: String((err as Error).message || err) });
      setTimeout(() => setToast(null), 2800);
    }
  }

  const dirty = useMemo(() => {
    const credChanged =
      apiKey.length > 0 ||
      (cred &&
        (normalizeProtoType(cred.proto_type) !== protoType ||
          (cred.base_url ?? "") !== baseUrl ||
          cred.model_id !== modelId ||
          cred.thinking_effort !== thinking ||
          (cred.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS) !== (parseContextWindowInput(contextWindow) ?? -1) ||
          (cred.label ?? "") !== label)) ||
      (!cred && (apiKey.length > 0 || modelId.length > 0));
    const cfgChanged = config ? config.max_parallel_scan !== maxParallel || (config.youngflow_max_parallel ?? 3) !== youngflowMaxParallel : false;
    return Boolean(credChanged) || cfgChanged;
  }, [apiKey, cred, protoType, baseUrl, modelId, thinking, contextWindow, label, config, maxParallel, youngflowMaxParallel]);

  const canSaveCred = true;

  function focusFirstCredentialError(errors: Record<string, string>) {
    const id = errors.modelId ? "settings-model-input" : errors.baseUrl ? "settings-base-url-input" : "";
    if (!id) return;
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => el?.focus(), 0);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setToast(null);
    try {
      const errors: Record<string, string> = {};
      if (!baseUrl.trim()) errors.baseUrl = i18n.t("settings.validation.baseUrlRequired");
      if (!modelId.trim()) errors.modelId = i18n.t("settings.validation.modelIdRequired");
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        focusFirstCredentialError(errors);
        setSaving(false);
        return;
      }
      setFieldErrors({});
      const contextWindowTokens = parseContextWindowInput(contextWindow);
      if (contextWindowTokens == null) {
        setToast({ kind: "err", msg: i18n.t("settings.model.contextWindow.invalid") });
        setSaving(false);
        return;
      }
      const ops: Array<Promise<unknown>> = [];

      const credChangedNoKey =
        cred &&
        apiKey.length === 0 &&
        (normalizeProtoType(cred.proto_type) !== protoType ||
          (cred.base_url ?? "") !== baseUrl ||
          cred.model_id !== modelId ||
          cred.thinking_effort !== thinking ||
          (cred.context_window_tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS) !== contextWindowTokens ||
          (cred.label ?? "") !== label);

      if (apiKey.length > 0 || isNewDraft || !cred) {
        ops.push(
          api.settings.saveCredential({
            // Include id when editing an existing credential; backend treats
            // absence as "create new".
            id: editingCredentialId ?? undefined,
            // `provider` is kept as a vendor metadata string on the backend;
            // we mirror proto_type so this stays consistent in the DB but
            // is no longer user-configurable in the UI.
            provider: protoType,
            proto_type: protoType,
            base_url: baseUrl || undefined,
            model_id: modelId,
            thinking_effort: thinking,
            label: label || undefined,
            context_window_tokens: contextWindowTokens,
            api_key: apiKey,
          }),
        );
      } else if (credChangedNoKey && cred) {
        // PATCH: update metadata without re-entering API key
        ops.push(
          api.settings.patchCredential(editingCredentialId ?? cred.id, {
            provider: protoType,
            proto_type: protoType,
            base_url: baseUrl || undefined,
            model_id: modelId,
            thinking_effort: thinking,
            label: label || undefined,
            context_window_tokens: contextWindowTokens,
          }),
        );
      }

      if (config && (config.max_parallel_scan !== maxParallel || (config.youngflow_max_parallel ?? 3) !== youngflowMaxParallel)) {
        ops.push(api.settings.updateSystemConfig({ max_parallel_scan: maxParallel, youngflow_max_parallel: youngflowMaxParallel }));
      }

      if (ops.length === 0) {
        setSaving(false);
        return;
      }

      await Promise.all(ops);

      // Refresh credential state so UI shows "saved" masked view.
      const savedId = editingCredentialId;
      const fresh = await api.settings.getCredential().catch(() => ({ credential: cred }));
      if (fresh?.credential && (!savedId || fresh.credential.id === savedId)) {
        setCred(fresh.credential);
        setEditingCredentialId(fresh.credential.id);
      }
      // After save, the draft row (if any) becomes a real row.
      setIsNewDraft(false);
      // Also refresh the credentials list so the new/edited row shows.
      const freshList = await api.settings
        .listCredentials()
        .catch(() => ({ credentials: [] as LlmCredential[] }));
      setCredentials(freshList.credentials);
      if (config) setConfig({ ...config, max_parallel_scan: maxParallel, youngflow_max_parallel: youngflowMaxParallel });
      if (isNewDraft) {
        const created = freshList.credentials.find((item) =>
          item.model_id === modelId &&
          normalizeProtoType(item.proto_type) === protoType &&
          (item.base_url ?? "") === baseUrl,
        ) ?? freshList.credentials[0];
        if (created) {
          setCred(created);
          setEditingCredentialId(created.id);
        }
      }
      setApiKey("");
      setToast({ kind: "ok", msg: i18n.t("settings.savedToast") });
      setTimeout(() => setToast(null), 2200);
    } catch (err) {
      const code = (err as Error)?.message ?? "";
      const msg =
        code === "NEEDS_API_KEY"
          ? i18n.t("settings.model.apiKey") + " — " + i18n.t("settings.saveError")
          : i18n.t("settings.saveError");
      setToast({ kind: "err", msg });
      setTimeout(() => setToast(null), 2800);
    } finally {
      setSaving(false);
    }
  }

  const isDark = themeStore.current() === "dark";
  const isEnterprise = (status?.edition ?? sysStatus?.edition) === "enterprise";
  const licColor = licenseStatusColor(status?.license?.status);

  /** Pull `/v1/models` using current form values (or saved credential as fallback). */
  async function fetchModels() {
    setModelFetchState({ kind: "loading" });
    try {
      // Pass current form values so user can fetch models before saving
      const formKey = apiKey || undefined;
      const formUrl = baseUrl || undefined;
      const formProto = protoType || undefined;
      const credId = editingCredentialId && !isNewDraft ? editingCredentialId : undefined;
      const resp = await api.settings.listModels(
        formUrl || formKey || credId
          ? { base_url: formUrl, api_key: formKey, proto_type: formProto, credential_id: credId }
          : undefined,
      );
      const ids = (resp.models ?? []).map((m) => m.id);
      if (ids.length === 0) {
        setModelOptions([]);
        setModelFetchState({ kind: "error", msg: i18n.t("settings.model.fetchNone") });
        return;
      }
      setModelOptions(ids);
      setModelFetchState({ kind: "idle" });
    } catch (err) {
      const code = (err as Error)?.message ?? "";
      setModelFetchState({
        kind: "error",
        msg: `${i18n.t("settings.model.fetchError")}${code ? ` (${code})` : ""}`,
      });
    }
  }

  /** Send a small chat-completion ping using the current form values.
   *  The backend endpoint always requires an `api_key` in the body (for
   *  Two modes (B1 fish request):
   *   1. Editing a saved credential and user hasn't re-typed the key
   *      — send `{credential_id}` so backend uses the already-stored key.
   *   2. New draft, or user typed a fresh key — send the full param set
   *      including `api_key`. */
  async function testConnection() {
    const useStored =
      editingCredentialId != null && !isNewDraft && apiKey.length === 0;
    const errors: Record<string, string> = {};
    if (!baseUrl.trim()) errors.baseUrl = i18n.t("settings.validation.baseUrlRequired");
    if (!modelId.trim()) errors.modelId = i18n.t("settings.validation.modelIdRequired");
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstCredentialError(errors);
      setTestState({ kind: "err", msg: Object.values(errors)[0] });
      return;
    }
    const contextWindowTokens = parseContextWindowInput(contextWindow);
    if (contextWindowTokens == null) {
      setFieldErrors({ contextWindow: i18n.t("settings.model.contextWindow.invalid") });
      setTestState({ kind: "err", msg: i18n.t("settings.model.contextWindow.invalid") });
      return;
    }
    setFieldErrors({});
    setTestState({ kind: "loading" });
    try {
      const resp = await api.settings.testModel(
        useStored
          ? { credential_id: editingCredentialId as string, context_window_tokens: contextWindowTokens, async: true }
          : {
              proto_type: protoType,
              base_url: baseUrl || undefined,
              model_id: modelId,
              api_key: apiKey,
              thinking_effort: thinking,
              context_window_tokens: contextWindowTokens,
              async: true,
            },
      );
      if (resp.run_id) {
        let finalResp = resp;
        for (let i = 0; i < 100; i++) {
          const run = await api.settings.getModelTestRun(resp.run_id);
          setTestState({ kind: "loading", diagnostics: run });
          if (run.status !== "running") {
            finalResp = { ok: run.ok, message: run.summary, error: run.ok ? undefined : run.summary, diagnostics: run };
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (finalResp.ok) setTestState({ kind: "ok", msg: finalResp.message, diagnostics: finalResp.diagnostics });
        else setTestState({ kind: "err", msg: finalResp.error ?? i18n.t("settings.model.testFail"), diagnostics: finalResp.diagnostics });
        return;
      }
      if (resp.ok) {
        setTestState({ kind: "ok", msg: resp.message, diagnostics: resp.diagnostics });
      } else {
        setTestState({
          kind: "err",
          msg: resp.error ?? i18n.t("settings.model.testFail"),
          diagnostics: resp.diagnostics,
        });
      }
    } catch (err) {
      const code = (err as Error)?.message ?? "ERR_INTERNAL";
      setTestState({ kind: "err", msg: code });
    }
  }

  // Role-aware sub-nav (sysStatus/isAdmin declared at top of component)

  const SUB_NAV_SECTIONS: Array<{ id: string; labelKey: string }> = isAdmin
    ? [
        ...(isEnterprise ? [{ id: "license", labelKey: "settings.nav.license" }] : []),
        { id: "credentials", labelKey: "settings.nav.credentials" },
        { id: "poc", labelKey: "settings.nav.poc" },
        ...(isEnterprise ? [{ id: "users", labelKey: "settings.nav.users" }] : []),
        { id: "skills", labelKey: "settings.nav.skills" },
        { id: "appearance", labelKey: "settings.nav.appearance" },
        { id: "engine", labelKey: "settings.nav.engine" },
      ]
    : [
        { id: "profile", labelKey: "settings.nav.profile" },
        { id: "credentials", labelKey: "settings.nav.credentials" },
        { id: "appearance", labelKey: "settings.nav.appearance" },
      ];

  return (
    <div
      data-testid="settings-page"
      style={{
        display: "flex",
        gap: "32px",
        maxWidth: 1120,
        margin: "0 auto",
        padding: "40px 24px",
        alignItems: "flex-start",
      }}
    >
      {/* Left sub-nav (sticky). Only shown when page content is loaded
          so the nav doesn't tease sections that aren't rendered yet. */}
      {!loading && (
        <aside
          data-testid="settings-subnav"
          style={{
            position: "sticky",
            top: "40px",
            width: "180px",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: "2px",
            paddingTop: "6px",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              padding: "8px 10px",
            }}
          >
            {i18n.t("settings.title")}
          </div>
          {SUB_NAV_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              data-testid={`settings-subnav-${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(s.id);
                if (el)
                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                history.replaceState(null, "", `#${s.id}`);
              }}
              style={{
                display: "block",
                padding: "8px 10px",
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--text-primary)",
                textDecoration: "none",
                borderRadius: "6px",
                borderLeft: "2px solid transparent",
                transition: "all 0.12s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.background =
                  "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLAnchorElement).style.background =
                  "transparent";
              }}
            >
              {i18n.t(s.labelKey)}
            </a>
          ))}
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0, maxWidth: "880px" }}>
      <h1
        style={{
          fontSize: "24px",
          fontWeight: 700,
          margin: "0 0 4px",
          color: "var(--text-primary)",
        }}
      >
        {i18n.t("settings.title")}
      </h1>
      <p
        style={{
          fontSize: "14px",
          color: "var(--text-secondary)",
          margin: "0 0 28px",
        }}
      >
        {i18n.t("settings.subtitle")}
      </p>

      {loading ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--text-secondary)" }}>
          {i18n.t("settings.loading")}
        </div>
      ) : (
        <>
          {/* Profile section (non-admin) */}
          {!isAdmin && (
            <>
              <div id="profile" style={{ scrollMarginTop: "20px" }} />
              <ProfileSection />
            </>
          )}

          {/* ============================================================= */}
          {/*  License Information (admin only)                              */}
          {/* ============================================================= */}
          {isAdmin && isEnterprise && <>
          <div id="license" style={{ scrollMarginTop: "20px" }} />
          <SettingsCard
            icon="key"
            title={i18n.t("settings.license.title")}
            desc={i18n.t("settings.license.desc")}
            testid="settings-card-license"
          >
            <InfoRow label={i18n.t("settings.license.status")}>
              <span
                data-testid="settings-license-status-pill"
                data-status={status?.license?.status ?? "unknown"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "3px 10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  background: licColor.bg,
                  color: licColor.fg,
                  lineHeight: 1.4,
                }}
              >
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: licColor.dot,
                  }}
                />
                {licenseStatusLabel(status?.license?.status)}
              </span>
            </InfoRow>
            {status?.version?.version ? (
              <InfoRow label={i18n.t("settings.license.currentVersion")}>
                <span data-testid="settings-current-version" style={{ fontSize: 13, fontWeight: 600 }}>{status.version.version}</span>
              </InfoRow>
            ) : null}
            {status?.license?.licensed_version ? (
              <InfoRow label={i18n.t("settings.license.licensedVersion")}>
                <span data-testid="settings-licensed-version" style={{ fontSize: 13, fontWeight: 600 }}>{status.license.licensed_version}</span>
              </InfoRow>
            ) : null}
            {status?.license?.expires_at ? (
              <InfoRow label={i18n.t("settings.license.expires")}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {status.license.expires_at.slice(0, 10)}
                </span>
              </InfoRow>
            ) : null}
            {typeof status?.license?.days_remaining === "number" ? (
              <InfoRow label={i18n.t("settings.license.remaining")}>
                <span
                  data-testid="settings-license-remaining"
                  style={{ fontSize: 13, fontWeight: 600 }}
                >
                  {status.license.days_remaining} {i18n.t("settings.license.days")}
                </span>
              </InfoRow>
            ) : null}
            {status?.installation_id ? (
              <InfoRow label={i18n.t("settings.license.installId")}>
                <span
                  style={{
                    fontSize: 12,
                    fontFamily: "'SF Mono', Menlo, monospace",
                    color: "var(--text-secondary)",
                  }}
                >
                  {status.installation_id}
                </span>
              </InfoRow>
            ) : null}
          </SettingsCard>
          </>}

          {/* ============================================================= */}
          {/*  Credentials — unified list + inline editor (Phase 9)         */}
          {/* ============================================================= */}
          <div id="credentials" style={{ scrollMarginTop: "20px" }} />
          <SettingsCard
            icon="lock"
            title={i18n.t("settings.credentials.title")}
            desc={i18n.t("settings.credentials.desc")}
            testid="settings-card-credentials"
            actions={
              <button
                type="button"
                data-testid="settings-credential-new-btn"
                onClick={newCredential}
                disabled={isNewDraft}
                style={{
                  padding: "6px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  background: "var(--bg-card)",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: isNewDraft ? "not-allowed" : "pointer",
                  opacity: isNewDraft ? 0.5 : 1,
                }}
              >
                {i18n.t("settings.credentials.new")}
              </button>
            }
          >
            {(() => {
              // Form body JSX — captured once; rendered inside draft row + editing rows.
              const FORM_BODY = (
                <>
            {/* Label (optional, used to distinguish credentials in list) */}
            <Field
              label={i18n.t("settings.model.labelLabel")}
              hint={i18n.t("settings.model.labelHint")}
            >
              <input
                data-testid="settings-credential-label-input"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={i18n.t("settings.model.labelPlaceholder")}
                style={FIELD_INPUT}
              />
            </Field>
            <div style={{ display: "flex", gap: "12px", marginBottom: "18px" }}>
              <div style={{ flex: 1 }}>
                <label
                  style={{
                    ...FIELD_LABEL,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    minHeight: "16px",
                  }}
                >
                  <span>{i18n.t("settings.model.protocol")}</span>
                  <span
                    data-testid="settings-protocol-help"
                    title={i18n.t("settings.model.protocolHelp")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      border: "1px solid var(--text-tertiary, var(--text-secondary))",
                      color: "var(--text-secondary)",
                      fontSize: "9px",
                      fontWeight: 700,
                      lineHeight: 1,
                      cursor: "help",
                      userSelect: "none",
                      opacity: 0.7,
                      textTransform: "none",
                    }}
                  >
                    i
                  </span>
                </label>
                <Select
                  testid="settings-protocol-select"
                  value={protoType}
                  onChange={(v) => {
                    setProtoType(v);
                    // Keep model id user-controlled; new credentials should not
                    // prefill provider-specific defaults.
                  }}
                  options={PROTOCOLS.map((p) => ({
                    value: p.value,
                    label: i18n.t(p.labelKey),
                  }))}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={{ ...FIELD_LABEL, display: "inline-flex", alignItems: "center", minHeight: "16px" }}>{i18n.t("settings.model.model")}</label>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    data-testid="settings-model-input"
                    type="text"
                    value={modelId}
                    onChange={(e) => { setModelId(e.target.value); setFieldErrors((prev) => ({ ...prev, modelId: "" })); }}
                    placeholder="e.g. deepseek-v4-flash"
                    list="settings-model-datalist"
                    style={{ ...FIELD_INPUT, flex: 1, minWidth: 0 }}
                  />
                  <button
                    type="button"
                    data-testid="settings-fetch-models-btn"
                    onClick={fetchModels}
                    disabled={modelFetchState.kind === "loading"}
                    title={i18n.t("settings.model.fetch")}
                    style={{
                      flexShrink: 0,
                      height: "40px",
                      padding: "0 12px",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      background: "var(--bg-card)",
                      color: "var(--text-secondary)",
                      fontSize: "12px",
                      fontWeight: 500,
                      cursor: modelFetchState.kind === "loading" ? "wait" : "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      whiteSpace: "nowrap",
                      lineHeight: 1,
                    }}
                    onMouseEnter={(e) => {
                      if (modelFetchState.kind !== "loading")
                        e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-card)")}
                  >
                    <Icon
                      name="search"
                      size={12}
                      style={{
                        animation:
                          modelFetchState.kind === "loading"
                            ? "va-spin 0.9s linear infinite"
                            : undefined,
                      }}
                    />
                    <span>
                      {modelFetchState.kind === "loading"
                        ? i18n.t("settings.model.fetching")
                        : i18n.t("settings.model.fetch")}
                    </span>
                  </button>
                </div>
                {/* Suggestions popover */}
                {modelOptions && modelOptions.length > 0 ? (
                  <div
                    data-testid="settings-model-suggestions"
                    style={{
                      marginTop: "6px",
                      padding: "6px",
                      border: "1px solid var(--border)",
                      borderRadius: "6px",
                      background: "var(--bg-page)",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "4px",
                      maxHeight: "160px",
                      overflowY: "auto",
                    }}
                  >
                    {modelOptions.map((id) => {
                      const active = id === modelId;
                      return (
                        <button
                          key={id}
                          type="button"
                          data-testid="settings-model-suggestion"
                          data-active={active || undefined}
                          onClick={() => { setModelId(id); setFieldErrors((prev) => ({ ...prev, modelId: "" })); }}
                          style={{
                            padding: "4px 10px",
                            fontSize: "11px",
                            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                            border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
                            borderRadius: "4px",
                            background: active
                              ? "var(--bg-active-filter)"
                              : "var(--bg-card)",
                            color: active ? "var(--brand)" : "var(--text-primary)",
                            cursor: "pointer",
                            fontWeight: active ? 600 : 500,
                            lineHeight: 1.4,
                          }}
                        >
                          {id}
                        </button>
                      );
                    })}
                  </div>
                ) : modelFetchState.kind === "error" ? (
                  <div
                    data-testid="settings-model-fetch-error"
                    style={{
                      marginTop: "6px",
                      fontSize: "11px",
                      color: "var(--brand)",
                      lineHeight: 1.5,
                    }}
                  >
                    {modelFetchState.msg}
                  </div>
                ) : null}
                {fieldErrors.modelId && <div style={{ color: "#dc2626", fontSize: "12px", marginTop: "4px" }}>{fieldErrors.modelId}</div>}
              </div>
            </div>

            <Field label={i18n.t("settings.model.baseUrl")}>
              <input
                data-testid="settings-base-url-input"
                type="text"
                value={baseUrl}
                onChange={(e) => { setBaseUrl(e.target.value); setFieldErrors((prev) => ({ ...prev, baseUrl: "" })); }}
                placeholder={i18n.t("settings.model.baseUrlPlaceholder")}
                style={FIELD_INPUT}
              />
              {fieldErrors.baseUrl && <div style={{ color: "#dc2626", fontSize: "12px", marginTop: "4px" }}>{fieldErrors.baseUrl}</div>}
            </Field>

            <Field
              label={i18n.t("settings.model.apiKey")}
              hint={cred ? i18n.t("settings.model.apiKeyLocked") : i18n.t("settings.model.apiKeyOptionalHint") }
            >
              <div style={{ position: "relative" }}>
                <input
                  data-testid="settings-api-key-input"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={
                    cred
                      ? cred.masked_key || "••••••••••••••••"
                      : i18n.t("settings.model.apiKeyPlaceholder")
                  }
                  autoComplete="off"
                  style={{ ...FIELD_INPUT, paddingRight: "40px" }}
                />
                <button
                  type="button"
                  data-testid="settings-api-key-toggle"
                  aria-label={showKey ? "Hide key" : "Show key"}
                  onClick={() => setShowKey((s) => !s)}
                  style={{
                    position: "absolute",
                    right: "8px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: "28px",
                    height: "28px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-secondary)",
                    background: "transparent",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <Icon name={showKey ? "eye-off" : "eye"} size={16} />
                </button>
              </div>
            </Field>

            <Field
              label={i18n.t("settings.model.thinking")}
              hint={i18n.t("settings.model.thinking.hint")}
            >
              <Select
                testid="settings-thinking-select"
                value={thinking}
                onChange={(v) => setThinking(v as ThinkingValue)}
                options={THINKING_VALUES.map((v) => ({
                  value: v,
                  label: i18n.t(`settings.model.thinking.${v}`),
                }))}
              />
            </Field>

            <Field
              label={i18n.t("settings.model.contextWindow")}
              hint={i18n.t("settings.model.contextWindow.hint")}
            >
              <input
                data-testid="settings-context-window-input"
                type="text"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="128k"
                style={FIELD_INPUT}
              />
            </Field>

            {/* Test Connection lives inside the model card so it's right
                next to the credentials the user just filled in, not
                buried at the bottom of the page next to "Save". */}
            <div
              style={{
                marginTop: "12px",
                paddingTop: "14px",
                borderTop: "1px solid var(--divider)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div>
                {(() => {
                  const canTest = true;
                  return (
                <button
                  type="button"
                  data-testid="settings-test-connection-btn"
                  onClick={testConnection}
                  disabled={testState.kind === "loading"}
                  title={undefined}
                  style={{
                    padding: "10px 16px",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    background: "var(--bg-card)",
                    color: "var(--text-primary)",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor:
                      testState.kind === "loading"
                        ? "not-allowed"
                        : "pointer",
                    opacity: 1,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    lineHeight: 1,
                  }}
                >
                  <Icon
                    name="activity"
                    size={13}
                    style={{
                      animation:
                        testState.kind === "loading"
                          ? "va-spin 0.9s linear infinite"
                          : undefined,
                    }}
                  />
                  {testState.kind === "loading"
                    ? i18n.t("settings.model.testing")
                    : i18n.t("settings.model.test")}
                </button>
                  );
                })()}
              </div>
              {(testState.kind === "ok" || testState.kind === "err") && (
                <div
                  data-testid="settings-test-result"
                  data-kind={testState.kind}
                  style={{
                    padding: "10px 14px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    lineHeight: 1.5,
                    fontFamily:
                      testState.kind === "err"
                        ? "'SF Mono', Menlo, Consolas, monospace"
                        : undefined,
                    background:
                      testState.kind === "ok"
                        ? "var(--bg-success)"
                        : "var(--bg-error)",
                    color:
                      testState.kind === "ok"
                        ? "var(--bg-success-text)"
                        : "var(--brand)",
                    border: `1px solid ${
                      testState.kind === "ok"
                        ? "var(--bg-success-border)"
                        : "rgba(220,38,38,0.28)"
                    }`,
                    wordBreak: "break-word",
                  }}
                >
                  <strong style={{ marginRight: "6px", fontWeight: 700 }}>
                    {testState.kind === "ok"
                      ? i18n.t("settings.model.testOk")
                      : i18n.t("settings.model.testFail")}
                  </strong>
                  {testState.kind === "ok"
                    ? testState.msg ?? ""
                    : testState.msg}
                  {testState.diagnostics && (
                    <div style={{ marginTop: "10px", display: "grid", gap: "6px", fontFamily: "inherit" }}>
                      {testState.diagnostics.checks.map((check) => (
                        <details key={check.id} style={{ borderTop: "1px solid rgba(0,0,0,0.08)", paddingTop: "6px" }}>
                          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                            [{check.status}] {check.label}{check.category ? ` · ${check.category}` : ""} — {check.message}
                          </summary>
                          <div style={{ marginTop: "6px", fontFamily: "'SF Mono', Menlo, Consolas, monospace", whiteSpace: "pre-wrap" }}>
                            {check.suggestion ? `建议：${check.suggestion}\n` : ""}
                            {check.httpStatus ? `HTTP：${check.httpStatus}\n` : ""}
                            {check.endpoint ? `Endpoint：${check.endpoint}\n` : ""}
                            {check.detail ?? ""}
                          </div>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
                </>
              );

              const renderExpandedRow = ({
                isDraft,
                c,
              }: {
                isDraft: boolean;
                c: LlmCredential | null;
              }) => {
                const title = isDraft
                  ? i18n.t("settings.credentials.newDraftTitle")
                  : c?.label || c?.provider || "";
                return (
                  <div
                    key={isDraft ? "__draft__" : c!.id}
                    data-testid="settings-credential-row"
                    data-cred-id={c?.id}
                    data-editing={true}
                    data-draft={isDraft || undefined}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      background: "var(--bg-card)",
                      overflow: "hidden",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                    }}
                  >
                    {/* Entire header is clickable to collapse — symmetric
                        with collapsed rows (where entire row is clickable to
                        expand). The chevron-up icon on the right mirrors the
                        chevron-down on collapsed rows. */}
                    <div
                      data-testid="settings-credential-collapse"
                      role="button"
                      tabIndex={0}
                      onClick={collapseExpanded}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          collapseExpanded();
                        }
                      }}
                      title={i18n.t("settings.credentials.collapse")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "12px 14px",
                        cursor: "pointer",
                        userSelect: "none",
                        background: "var(--bg-page)",
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLDivElement).style.background =
                          "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLDivElement).style.background =
                          "var(--bg-page)";
                      }}
                    >
                      {/* Left marker — same visual language as collapsed
                          rows: ★ character, colored orange when the credential
                          is the default, dimmed otherwise. For the draft row
                          (no saved credential yet) we fall back to a "+" icon. */}
                      {isDraft ? (
                        <Icon
                          name="plus"
                          size={16}
                          style={{
                            color: "var(--text-secondary)",
                            flexShrink: 0,
                          }}
                        />
                      ) : (
                        <span
                          aria-hidden
                          title={
                            c?.is_default
                              ? i18n.t("settings.credentials.default")
                              : ""
                          }
                          style={{
                            width: "18px",
                            height: "18px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: c?.is_default
                              ? "var(--sev-medium)"
                              : "var(--text-secondary)",
                            opacity: c?.is_default ? 1 : 0.25,
                            fontSize: "14px",
                            lineHeight: 1,
                            flexShrink: 0,
                          }}
                        >
                          ★
                        </span>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "13px",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {title}
                        </div>
                        {!isDraft && c && (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "var(--text-secondary)",
                              fontFamily:
                                "'SF Mono', Menlo, Consolas, monospace",
                              marginTop: "2px",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {c.model_id}
                            {c.base_url ? " · " + c.base_url : ""}
                          </div>
                        )}
                      </div>
                      <Icon
                        name="chevron-up"
                        size={14}
                        style={{
                          color: "var(--text-secondary)",
                          flexShrink: 0,
                        }}
                      />
                    </div>
                    <div
                      style={{
                        padding: "14px 16px 16px",
                        borderTop: "1px solid var(--divider)",
                      }}
                    >
                      {FORM_BODY}
                      <div
                        style={{
                          marginTop: "18px",
                          paddingTop: "14px",
                          borderTop: "1px solid var(--divider)",
                          display: "flex",
                          gap: "8px",
                          flexWrap: "wrap",
                          alignItems: "center",
                        }}
                      >
                        {!isDraft && c && c.can_edit !== false && !c.is_default && (
                          <button
                            type="button"
                            data-testid="settings-credential-setdefault"
                            onClick={() => handleSetDefault(c)}
                            style={CRED_ROW_BTN}
                          >
                            {i18n.t("settings.credentials.setDefault")}
                          </button>
                        )}
                        {!isDraft && c && c.can_edit !== false && (
                          <button
                            type="button"
                            data-testid="settings-credential-delete"
                            onClick={() => handleDeleteCredential(c)}
                            style={{
                              ...CRED_ROW_BTN,
                              color: "var(--brand)",
                              borderColor: "rgba(220,38,38,0.3)",
                            }}
                          >
                            {i18n.t("settings.credentials.delete")}
                          </button>
                        )}
                        <span style={{ flex: 1 }} />
                        <button
                          type="button"
                          data-testid="settings-credential-save"
                          disabled={saving || (!isDraft && c?.can_edit === false)}
                          onClick={handleSave}
                          style={{
                            padding: "6px 16px",
                            border: "none",
                            borderRadius: "6px",
                            background: saving
                              ? "var(--bg-disabled)"
                              : "var(--brand)",
                            color: "var(--btn-primary-text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor:
                              saving ? "not-allowed" : "pointer",
                            opacity: 1,
                          }}
                        >
                          {saving
                            ? i18n.t("settings.saving")
                            : isDraft
                              ? i18n.t("settings.credentials.create")
                              : c?.can_edit === false
                                ? "只读"
                                : i18n.t("settings.credentials.update")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              };

              const renderCollapsedRow = (c: LlmCredential) => (
                <div
                  key={c.id}
                  data-testid="settings-credential-row"
                  data-cred-id={c.id}
                  data-is-default={c.is_default || undefined}
                  onClick={() => editCredential(c)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid var(--border)",
                    background: "var(--bg-page)",
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "var(--bg-page)";
                  }}
                >
                  <span
                    aria-hidden
                    title={
                      c.is_default
                        ? i18n.t("settings.credentials.default")
                        : ""
                    }
                    style={{
                      width: "18px",
                      height: "18px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: c.is_default
                        ? "var(--sev-medium)"
                        : "var(--text-secondary)",
                      opacity: c.is_default ? 1 : 0.25,
                      fontSize: "14px",
                      lineHeight: 1,
                    }}
                  >
                    ★
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "var(--text-primary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.label || c.provider}
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                        marginTop: "2px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.model_id}
                      {` · ${i18n.t("settings.model.contextWindow.short").replace("{value}", formatContextWindow(c.context_window_tokens))}`}
                      {c.base_url ? " · " + c.base_url : ""}
                      {c.masked_key ? " · " + c.masked_key : ""}
                    </div>
                  </div>
                  {(c.credential_health === "decrypt_failed" || c.credential_health === "key_unavailable") && (
                    <span
                      title={c.credential_health === "key_unavailable" ? "凭证加密 key 未配置。请管理员设置 VULNAGENT_MASTER_KEY_FILE。" : "凭证无法用当前 master key 解密，请重新输入 API Key 并保存。"}
                      style={{
                        fontSize: "11px",
                        color: "#b45309",
                        background: "rgba(180,83,9,0.08)",
                        borderRadius: "999px",
                        padding: "2px 8px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.credential_health === "key_unavailable" ? "⚠ key 未配置" : "⚠ 无法解密"}
                    </span>
                  )}
                  <Icon
                    name="chevron-down"
                    size={14}
                    style={{
                      color: "var(--text-secondary)",
                      flexShrink: 0,
                    }}
                  />
                </div>
              );

              return (
                <div
                  data-testid="settings-credentials-list"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  {isNewDraft &&
                    renderExpandedRow({ isDraft: true, c: null })}
                  {credentials.length === 0 && !isNewDraft ? (
                    <div
                      style={{
                        padding: "20px 4px",
                        color: "var(--text-secondary)",
                        fontSize: "13px",
                      }}
                    >
                      {i18n.t("settings.credentials.empty")}
                    </div>
                  ) : (
                    [
                      { label: "全局凭证", items: credentials.filter((c) => c.scope === "global" || !c.scope) },
                      { label: "我的凭证", items: credentials.filter((c) => c.scope === "personal") },
                    ].filter((group) => group.items.length > 0).map((group) => (
                      <div key={group.label} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", padding: "4px 2px" }}>
                          {group.label}
                        </div>
                        {group.items.map((c) =>
                          editingCredentialId === c.id
                            ? renderExpandedRow({ isDraft: false, c })
                            : renderCollapsedRow(c),
                        )}
                      </div>
                    ))
                  )}
                </div>
              );
            })()}
          </SettingsCard>

          {/* ============================================================= */}
          {/*  Language & Appearance                                          */}
          {/* ============================================================= */}
          {isAdmin && (
            <>
              <div id="poc" style={{ scrollMarginTop: "20px" }} />
              <PocSettingsSection />

              {isEnterprise ? (
                <>
                  <div id="users" style={{ scrollMarginTop: "20px" }} />
                  <UsersSection />
                </>
              ) : null}

              <div id="skills" style={{ scrollMarginTop: "20px" }} />
              <SkillsSection />
            </>
          )}

          <div id="appearance" style={{ scrollMarginTop: "20px" }} />
          <SettingsCard
            icon="globe"
            title={i18n.t("settings.appearance.title")}
            desc={i18n.t("settings.appearance.desc")}
            testid="settings-card-appearance"
          >
            <Field
              label={i18n.t("settings.appearance.langLabel")}
              hint={i18n.t("settings.appearance.langHint")}
            >
              <SegGroup
                testid="settings-lang-seg"
                value={i18n.locale() as "zh" | "en"}
                onChange={(v) => i18n.setLocale(v)}
                items={[
                  { value: "en", label: "English" },
                  { value: "zh", label: "中文" },
                ]}
              />
            </Field>

            <Field label={i18n.t("settings.appearance.themeLabel")}>
              <SegGroup
                testid="settings-theme-seg"
                value={isDark ? "dark" : "light"}
                onChange={(v) => themeStore.set(v)}
                items={[
                  {
                    value: "light",
                    label: (
                      <>
                        <Icon name="sun" size={14} />
                        <span>{i18n.t("nav.theme.light")}</span>
                      </>
                    ),
                  },
                  {
                    value: "dark",
                    label: (
                      <>
                        <Icon name="moon" size={14} />
                        <span>{i18n.t("nav.theme.dark")}</span>
                      </>
                    ),
                  },
                ]}
              />
            </Field>
          </SettingsCard>

          {isAdmin && <>
          {/* ============================================================= */}
          {/*  Engine Settings                                                */}
          {/* ============================================================= */}
          <div id="engine" style={{ scrollMarginTop: "20px" }} />
          <SettingsCard
            icon="sliders"
            title={i18n.t("settings.engine.title")}
            desc={i18n.t("settings.engine.desc")}
            testid="settings-card-engine"
          >
            <Field
              label={i18n.t("settings.engine.maxParallel")}
              hint={i18n.t("settings.engine.maxParallel.hint")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <input
                  type="range"
                  data-testid="settings-max-parallel-slider"
                  min={1}
                  max={10}
                  value={maxParallel}
                  onChange={(e) => setMaxParallel(Number(e.target.value))}
                  style={{ flex: 1, height: "6px", accentColor: "var(--brand)" }}
                />
                <span
                  data-testid="settings-max-parallel-value"
                  style={{
                    fontSize: "20px",
                    fontWeight: 600,
                    minWidth: "24px",
                    textAlign: "center",
                    color: "var(--text-primary)",
                    lineHeight: 1,
                  }}
                >
                  {maxParallel}
                </span>
              </div>
            </Field>
            <Field
              label={<span style={{ textTransform: "none" }}>{i18n.t("settings.engine.agentParallel")}</span>}
              hint={i18n.t("settings.engine.agentParallel.hint")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <input
                  type="range"
                  data-testid="settings-youngflow-max-parallel-slider"
                  min={1}
                  max={10}
                  value={youngflowMaxParallel}
                  onChange={(e) => setYoungflowMaxParallel(Number(e.target.value))}
                  style={{ flex: 1, height: "6px", accentColor: "var(--brand)" }}
                />
                <span
                  data-testid="settings-youngflow-max-parallel-value"
                  style={{ fontSize: "20px", fontWeight: 600, minWidth: "24px", textAlign: "center", color: "var(--text-primary)", lineHeight: 1 }}
                >
                  {youngflowMaxParallel}
                </span>
              </div>
            </Field>
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
              {i18n.t("settings.engine.estimatedModelConcurrency").replace("{scan}", String(maxParallel)).replace("{agent}", String(youngflowMaxParallel)).replace("{total}", String(maxParallel * youngflowMaxParallel))}
            </div>
          </SettingsCard>

          {/* Save is the only bottom-level action now; Test Connection
              moved to live inside the Model Config card. */}
          <div style={{ marginTop: "8px" }}>
            <button
              type="button"
              data-testid="settings-save-btn"
              disabled={saving}
              onClick={handleSave}
              style={{
                width: "100%",
                padding: "12px",
                background: !dirty || !canSaveCred ? "var(--bg-disabled)" : "var(--brand)",
                color: "var(--btn-primary-text)",
                border: "none",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 600,
                cursor: !dirty || saving || !canSaveCred ? "not-allowed" : "pointer",
                opacity: !dirty || !canSaveCred ? 0.6 : 1,
                transition: "background 0.15s, opacity 0.15s",
              }}
            >
              {saving ? i18n.t("settings.saving") : i18n.t("settings.saveBtn")}
            </button>
          </div>
          </>}
        </>
      )}
      </div>

      {/* ============================================================= */}
      {/*  Toast                                                         */}
      {/* ============================================================= */}
      {toast ? (
        <div
          data-testid="settings-toast"
          data-kind={toast.kind}
          role="status"
          style={{
            position: "fixed",
            bottom: "32px",
            left: "50%",
            transform: "translateX(-50%)",
            background: toast.kind === "ok" ? "rgba(0,0,0,0.92)" : "var(--brand)",
            color: "#fff",
            padding: "10px 24px",
            borderRadius: "8px",
            fontSize: "13px",
            fontWeight: 500,
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            zIndex: 400,
            transition: "opacity 0.2s",
            pointerEvents: "none",
          }}
        >
          {toast.msg}
        </div>
      ) : null}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 0",
        borderTop: "1px solid var(--divider)",
      }}
    >
      <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>{label}</span>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  testid?: string;
}) {
  return (
    <select
      data-testid={testid}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...FIELD_INPUT,
        appearance: "none",
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 12px center",
        paddingRight: "32px",
        cursor: "pointer",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
