/** Credentials section (extracted from SettingsPage): unified list + inline editor. */
import { useEffect, useRef, useState } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { api, type LlmCredential } from "../../../shared/api/client.js";
import { CloudRouterPromo, CredentialsEmptyNotice } from "./CloudRouterPromo.js";
import {
  resolveModelCapabilities,
  type ModelCapabilities,
} from "./model-capabilities.js";
import {
  CredentialTestProgress,
  streamCredentialTest,
} from "./CredentialTestProgress.js";
import { CloudRouterBalanceGlance, CloudRouterBalanceStrip } from "./CloudRouterBalance.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";
import { useEdition } from "../../../shared/hooks/useEdition.js";
import {
  FIELD_INPUT,
  FIELD_LABEL,
  SettingsCard,
  Field,
  ensureSpinKeyframes,
} from "./settings-ui.js";
import type { CSSProperties } from "react";

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


// Inject once: a simple keyframe animation the fetch/test buttons use
// while a network call is in flight. Scoped by a fixed id so hot-reload
// doesn't duplicate it.

export function CredentialsSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  useEffect(() => ensureSpinKeyframes(), []);

  // Must be declared before any useEffect that references sysStatus
  const { data: sysStatus } = useSystemStatus();
  const { isSaas } = useEdition();
  const [cred, setCred] = useState<LlmCredential | null>(null);
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


  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Model enhancements
  const [modelOptions, setModelOptions] = useState<string[] | null>(null);
  /** Raw model items (may carry reasoning/thinking_levels once backend is capability-aware). */
  const [modelCapsMap, setModelCapsMap] = useState<Record<string, ModelCapabilities>>({});
  /** Which form fetched the suggestion list ("new" draft or credential id).
   *  Render is owner-gated so a list fetched on credential A never bleeds
   *  into credential B's form (task-aaf8ac15, fish screenshot). */
  const [modelListOwner, setModelListOwner] = useState<string | null>(null);
  /** Core-field snapshot of the credential being edited (edit-gate, fish
   *  2026-08-04: 改核心字段必须先通过测试再保存，不许点了才报错). */
  const [editCoreSnap, setEditCoreSnap] = useState<{ proto: string; baseUrl: string; modelId: string } | null>(null);
  /** Fingerprint of the form values the last successful test ran against. */
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);
  const [testChecks, setTestChecks] = useState<import("../../../shared/api/client").ModelDiagnosticCheck[]>([]);
  const [modelFetchState, setModelFetchState] = useState<
    { kind: "idle" | "loading" } | { kind: "error"; msg: string }
  >({ kind: "idle" });
  const [testState, setTestState] = useState<
    { kind: "idle" | "loading"; diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult }
    | { kind: "ok"; msg?: string; diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult }
    | { kind: "err"; msg: string; diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult }
  >({ kind: "idle" });
  /**
   * L4 agent-loop verdict row (fish 2026-08-05: L4 restored, badge stays
   * gone — verdict shows as a fourth row in the test panel). Fired by the
   * backend after a gated save; we poll listCredentials until the status
   * settles (passed/failed) or the poll budget runs out.
   */
  const [l4, setL4] = useState<{ credId: string; status: "running" | "passed" | "failed" } | null>(null);
  const l4PollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopL4Poll = () => {
    if (l4PollRef.current) { clearInterval(l4PollRef.current); l4PollRef.current = null; }
  };
  useEffect(() => () => stopL4Poll(), []);
  const startL4Tracking = (credId: string) => {
    stopL4Poll();
    setL4({ credId, status: "running" });
    let tries = 0;
    l4PollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const list = await api.settings.listCredentials();
        const row = list.credentials.find((c) => c.id === credId);
        const st = row?.deep_verified_status;
        if (st === "passed" || st === "failed") {
          setL4({ credId, status: st });
          stopL4Poll();
          return;
        }
      } catch { /* transient — keep polling */ }
      if (tries >= 40) stopL4Poll(); // ~2min budget; row stays "running" otherwise
    }, 3000);
  };

  useEffect(() => {
    let mounted = true;
    const fetches: Promise<unknown>[] = [
      api.settings.getCredential().catch(() => ({ credential: null as LlmCredential | null })),
      api.settings.listCredentials().catch(() => ({ credentials: [] as LlmCredential[] })),
    ];
    Promise.all(fetches).then(([credResp, credList]) => {
      if (!mounted) return;
      const cr = credResp as { credential: LlmCredential | null } | undefined;
      if (cr?.credential) {
        // Don't auto-expand — just store as reference for dirty checks
        setCred(cr.credential);
      }
      // Start with no credential expanded
      setEditingCredentialId(null);
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
    resetModelList();
    setEditCoreSnap({
      proto: normalizeProtoType(c.proto_type),
      baseUrl: c.base_url ?? "",
      modelId: c.model_id,
    });
    setTestedFingerprint(null);
  }

  /** Reset the model suggestion list (switch of edit target — spec ①). */
  function resetModelList() {
    setModelOptions(null);
    setModelCapsMap({});
    setModelFetchState({ kind: "idle" });
    setModelListOwner(null);
  }

  /** Collapse the current expanded row (no draft, no editing). */
  function collapseExpanded() {
    setCred(null);
    setEditingCredentialId(null);
    setIsNewDraft(false);
    setApiKey("");
    setTestState({ kind: "idle" });
    setToast(null);
    resetModelList();
    setEditCoreSnap(null);
    setTestedFingerprint(null);
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
    setTestChecks([]);
    resetModelList();
    setEditCoreSnap(null);
    setTestedFingerprint(null);
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

  function focusFirstCredentialError(errors: Record<string, string>) {
    const id = errors.modelId ? "settings-model-input" : errors.baseUrl ? "settings-base-url-input" : "";
    if (!id) return;
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => el?.focus(), 0);
  }

  // Save the LLM credential. Triggered by the credential card's own "save" button.
  async function saveCredential() {
    if (saving) return;
    setSaving(true);
    setToast(null);
    try {
      const contextWindowTokens = parseContextWindowInput(contextWindow);
      const errors: Record<string, string> = {};
      if (!baseUrl.trim()) errors.baseUrl = i18n.t("settings.validation.baseUrlRequired");
      if (!modelId.trim()) errors.modelId = i18n.t("settings.validation.modelIdRequired");
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        focusFirstCredentialError(errors);
        setSaving(false);
        return;
      }
      if (contextWindowTokens == null) {
        setToast({ kind: "err", msg: i18n.t("settings.model.contextWindow.invalid") });
        setSaving(false);
        return;
      }
      setFieldErrors({});
      const ops: Array<Promise<unknown>> = [];

      // Single save path (fish 2026-08-04 P1): every edit goes through PUT.
      // Blank key = keep stored (backend preserves key material); the backend
      // compares core fields and only enforces the L1-L3 gate when they
      // changed. PATCH exists for optional metadata only.
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
      // L4 fired backend-side only when core fields changed; a fresh gate
      // pass is exactly that signal on this side.
      const trackedId = editingCredentialId ?? cred?.id;
      if (testPassedForCurrent && trackedId) startL4Tracking(trackedId);
      setToast({ kind: "ok", msg: i18n.t("settings.savedToast") });
      setTimeout(() => setToast(null), 2200);
    } catch (err) {
      const code = (err as Error)?.message ?? "";
      const errCode = (err as { code?: string })?.code;
      const diagnostics = (err as { diagnostics?: import("../../../shared/api/client").ModelDiagnosticResult })?.diagnostics;
      // Save-gate: tests failed → show the per-check report inline (not just a toast).
      if (errCode === "ERR_CREDENTIAL_TEST_FAILED" && diagnostics) {
        setTestChecks(diagnostics.checks ?? []);
        setTestState({ kind: "err", msg: diagnostics.summary || i18n.t("settings.model.testFail"), diagnostics });
      }
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



  /** Pull `/v1/models` using current form values (or saved credential as fallback). */
  async function fetchModels() {
    // Owner tag at fetch start: if the user switches edit target while the
    // request is in flight, the late response stays hidden (owner-gate in render).
    const ownerKey = isNewDraft ? "new" : editingCredentialId;
    setModelListOwner(ownerKey);
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
      const caps: Record<string, ModelCapabilities> = {};
      for (const m of resp.models ?? []) caps[m.id] = resolveModelCapabilities(m);
      setModelCapsMap(caps);
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

  /** Capabilities of the currently selected model (from last model fetch). */
  const activeModelCaps: ModelCapabilities | null = modelId ? (modelCapsMap[modelId] ?? null) : null;
  /** Identity of the form currently being edited — suggestions/fetch errors
   *  render only when the list's owner matches (spec ② owner-gate). */
  const currentFormKey = isNewDraft ? "new" : editingCredentialId;
  const modelListVisible = modelListOwner === currentFormKey;

  /* --- Edit-mode save gate (fish 2026-08-04) ---
   * Core fields (proto/baseUrl/modelId/Key) dirty → save disabled until the
   * connection test passes against the CURRENT values. Optional-only edits
   * save directly. Backend enforces the same rule; this gate keeps the user
   * from ever seeing a click-then-fail. */
  const normUrl = (u: string) => u.trim().replace(/\/+$/, "");
  const coreFingerprint = () =>
    [protoType, normUrl(baseUrl), modelId.trim(), apiKey.trim() ? "newkey" : "keep"].join("|");
  const coreChanged =
    !isNewDraft &&
    editCoreSnap != null &&
    (protoType !== editCoreSnap.proto ||
      normUrl(baseUrl) !== normUrl(editCoreSnap.baseUrl) ||
      modelId.trim() !== editCoreSnap.modelId ||
      apiKey.trim() !== "");
  /** Un-gate ONLY when the last test run PASSED against the current form
   *  values. Fingerprint alone is not enough: a stale pass fingerprint can
   *  outlive a later FAILED run on the same values (QA round 2: dead-host
   *  test showed red yet the button un-gated). testState.kind === "err"
   *  must always keep the gate closed. */
  const testPassedForCurrent = testState.kind === "ok" && testedFingerprint === coreFingerprint();
  const saveGateBlocked = coreChanged && !testPassedForCurrent;

  /** Fetch-models button needs URL + a usable key (typed, or the stored one
   *  when editing) — fish: 模型列表依赖 key/url，排在其后且未填禁用. */
  const canFetchModels =
    baseUrl.trim() !== "" && (apiKey.trim() !== "" || (!isNewDraft && editingCredentialId != null));
  /** Thinking levels for the UI: model-specific when known, standard five otherwise. */
  const thinkingLevelsForUi: string[] = activeModelCaps?.thinkingLevels ?? [...THINKING_VALUES];

  /** Clamp thinking when the selected model's supported levels change. */
  useEffect(() => {
    if (!activeModelCaps) return;
    if (!activeModelCaps.reasoning) {
      if (thinking !== "off") setThinking("off");
      return;
    }
    if (!activeModelCaps.thinkingLevels.includes(thinking)) {
      const preferred = ["medium", "low", "high"].find((l) => activeModelCaps.thinkingLevels.includes(l));
      setThinking((preferred ?? activeModelCaps.thinkingLevels[0] ?? "medium") as ThinkingValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, activeModelCaps?.reasoning, activeModelCaps?.thinkingLevels?.join("|")]);

  /** Test the CURRENT form values against L1-L3 (SSE progressive).
   *  Key fallback: in edit mode with the key left blank, credential_id lets
   *  the backend reuse the stored key — but proto/URL/model ALWAYS come from
   *  the form. (QA P1 2026-08-04: the old useStored branch sent ONLY
   *  credential_id, so a dirty edit with blank key tested the STORED
   *  credential — old good URL passed, save un-gated, "假绿".) */
  async function testConnection() {
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
    stopL4Poll();
    setL4(null);
    setTestChecks([]);
    const payload = {
      // credential_id rides along ONLY for stored-key fallback (backend
      // merges: form values win, key falls back to stored when blank).
      credential_id: !isNewDraft && editingCredentialId ? editingCredentialId : undefined,
      proto_type: protoType,
      base_url: baseUrl || undefined,
      model_id: modelId,
      api_key: apiKey || undefined,
      thinking_effort: thinking,
      context_window_tokens: contextWindowTokens,
      async: true,
    };

    /** Legacy path: run_id polling; each tick feeds the same progressive UI. */

    /** Stream-first: SSE endpoint. Track checks locally so a stream that
     *  ends without a report frame can still finalize (onComplete fallback). */
    /** Stream-first: SSE endpoint. The check accumulator MUST live outside
     *  React state: updaters flush asynchronously, so when check_failed and
     *  the stream close land in the same chunk, onComplete would read the
     *  accumulator BEFORE the fail was flushed in — stamping "ok" on a red
     *  test (QA round 3: dead host showed red ✗ yet save un-gated). */
    const acc: import("../../../shared/api/client").ModelDiagnosticCheck[] = [];
    await streamCredentialTest(payload as Record<string, unknown>, {
      onEvent: (ev) => {
        if (ev.type === "report") {
          const report = ev.report;
          setTestChecks(report.checks ?? []);
          if (report.ok) {
            setTestState({ kind: "ok", msg: report.summary, diagnostics: report });
            setTestedFingerprint(coreFingerprint());
          } else {
            setTestState({ kind: "err", msg: report.summary || i18n.t("settings.model.testFail"), diagnostics: report });
          }
          return;
        }
        const incoming = ev.check;
        const status = ev.type === "check_started" ? "running" : incoming.status;
        const next = { ...incoming, status } as typeof incoming;
        const idx = acc.findIndex((c) => c.id === incoming.id);
        if (idx >= 0) acc[idx] = { ...acc[idx], ...next };
        else acc.push(next);
        setTestChecks([...acc]);
      },
      onError: () => {
        setTestState({ kind: "err", msg: i18n.t("settings.model.testFail") });
      },
      onComplete: (sawReport) => {
        if (sawReport) return;
        // Stream closed without a terminal report frame — finalize from the
        // checks we did get instead of hanging on 「测试中…」 (fish report).
        if (acc.length === 0) {
          setTestState({ kind: "err", msg: i18n.t("settings.model.testFail") });
          return;
        }
        const failed = acc.some((c) => c.status === "fail");
        if (failed) {
          setTestState({ kind: "err", msg: i18n.t("settings.model.testFail") });
        } else {
          setTestState({ kind: "ok" });
          setTestedFingerprint(coreFingerprint());
        }
      },
    });
  }


  return (
    <>
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
            {loading ? (
              <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
                {i18n.t("settings.loading")}
              </div>
            ) : credentials.length === 0 && !isNewDraft ? (
              <CredentialsEmptyNotice onAdd={newCredential} />
            ) : null}
            {isSaas ? <CloudRouterPromo /> : null}
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
              {fieldErrors.baseUrl && <div style={{ color: "var(--danger)", fontSize: "12px", marginTop: "4px" }}>{fieldErrors.baseUrl}</div>}
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

            <div style={{ marginBottom: "18px" }}>
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
                  disabled={modelFetchState.kind === "loading" || !canFetchModels}
                  title={canFetchModels ? i18n.t("settings.model.fetch") : i18n.t("settings.model.fetchNeedUrlKey")}
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
              {/* Suggestions popover — owner-gated (task-aaf8ac15) */}
              {modelListVisible && modelOptions && modelOptions.length > 0 ? (
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
              ) : modelListVisible && modelFetchState.kind === "error" ? (
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
              {fieldErrors.modelId && <div style={{ color: "var(--danger)", fontSize: "12px", marginTop: "4px" }}>{fieldErrors.modelId}</div>}
            </div>

            <Field
              label={i18n.t("settings.model.thinking")}
              hint={i18n.t("settings.model.thinking.hint")}
            >
              <Select
                testid="settings-thinking-select"
                value={thinking}
                disabled={activeModelCaps !== null && !activeModelCaps.reasoning}
                onChange={(v) => setThinking(v as ThinkingValue)}
                options={thinkingLevelsForUi.map((v) => ({
                  value: v,
                  label: i18n.t(`settings.model.thinking.${v}`),
                }))}
              />
              {activeModelCaps && !activeModelCaps.reasoning ? (
                <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {i18n.t("settings.model.thinking.notSupported")}
                </p>
              ) : null}
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
                {
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
                }
              </div>
              {(testState.kind === "ok" || testState.kind === "err" || (testState.kind === "loading" && testChecks.length > 0)) && (
                <div data-testid="settings-test-result" data-kind={testState.kind}>
                  {testChecks.length > 0 ? (
                    <CredentialTestProgress
                      checks={testChecks}
                      report={testState.diagnostics ?? null}
                      running={testState.kind === "loading"}
                      l4={l4 ? { status: l4.status } : null}
                    />
                  ) : testState.kind !== "loading" ? (
                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: "6px",
                        fontSize: "12px",
                        lineHeight: 1.5,
                        background:
                          testState.kind === "ok"
                            ? "var(--bg-success)"
                            : "var(--bg-error)",
                        color:
                          testState.kind === "ok"
                            ? "var(--bg-success-text)"
                            : "var(--danger)",
                        border: `1px solid ${
                          testState.kind === "ok"
                            ? "var(--bg-success-border)"
                            : "rgba(194,40,40,0.28)"
                        }`,
                        wordBreak: "break-word",
                      }}
                    >
                      <strong style={{ marginRight: "6px", fontWeight: 700 }}>
                        {testState.kind === "ok"
                          ? i18n.t("settings.model.testOk")
                          : i18n.t("settings.model.testFail")}
                      </strong>
                      {(testState.kind === "ok" || testState.kind === "err") ? (testState.msg ?? "") : ""}
                    </div>
                  ) : null}
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
                      {!isDraft && c && isSaas ? <CloudRouterBalanceStrip baseUrl={c.base_url} /> : null}
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
                              color: "var(--danger)",
                              borderColor: "var(--danger-border)",
                            }}
                          >
                            {i18n.t("settings.credentials.delete")}
                          </button>
                        )}
                        <span style={{ flex: 1 }} />
                        <button
                          type="button"
                          data-testid="settings-credential-save"
                          disabled={saving || (!isDraft && c?.can_edit === false) || saveGateBlocked}
                          title={saveGateBlocked ? i18n.t("settings.creds.gate.coreModified") : undefined}
                          onClick={saveCredential}
                          style={{
                            padding: "6px 16px",
                            border: "none",
                            borderRadius: "6px",
                            background: saving || saveGateBlocked
                              ? "var(--bg-disabled)"
                              : "var(--brand)",
                            color: "var(--btn-primary-text)",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor:
                              saving || saveGateBlocked ? "not-allowed" : "pointer",
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
                        {saveGateBlocked ? (
                          <div
                            data-testid="settings-credential-gate-hint"
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "flex-end",
                              gap: "5px",
                              fontSize: "11.5px",
                              color: "var(--sev-medium)",
                              lineHeight: 1.4,
                            }}
                          >
                            <Icon name="alert-triangle" size={12} />
                            {i18n.t("settings.creds.gate.coreModified")}
                          </div>
                        ) : null}
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
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                        {c.label || c.provider}
                      </span>
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
                      title={c.credential_health === "key_unavailable" ? "凭证加密 key 未配置。请管理员设置 VULNHUNTER_MASTER_KEY_FILE。" : "凭证无法用当前 master key 解密，请重新输入 API Key 并保存。"}
                      style={{
                        fontSize: "11px",
                        color: "var(--sev-medium)",
                        background: "rgba(180,83,9,0.08)",
                        borderRadius: "999px",
                        padding: "2px 8px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.credential_health === "key_unavailable" ? "⚠ key 未配置" : "⚠ 无法解密"}
                    </span>
                  )}
                  {isSaas ? <CloudRouterBalanceGlance baseUrl={c.base_url} /> : null}
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

      {/* Toast */}
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
    </>
  );
}

function Select({
  value,
  onChange,
  options,
  testid,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <select
      data-testid={testid}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...FIELD_INPUT,
        appearance: "none",
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "right 12px center",
        paddingRight: "32px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
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
