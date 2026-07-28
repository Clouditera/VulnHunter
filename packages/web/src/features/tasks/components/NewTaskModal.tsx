import { useState, useRef, useEffect } from "react";
import { api, type LlmCredential, type SourceArchivePolicy, type SandboxCapacity } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

const DEFAULT_SOURCE_ARCHIVE_POLICY: SourceArchivePolicy = {
  max_mb: 500,
  max_bytes: 500 * 1024 * 1024,
  source_archive_upload_ceiling_mb: 2048,
  formats: ["zip", "tar", "tar.gz"],
  extensions: [".zip", ".tar", ".tar.gz", ".tgz"],
  accept: ".zip,.tar,.tar.gz,.tgz",
};

function isValidHttpGitUrl(value: string): boolean {
  if (!value || value.startsWith("-")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function fileHasSupportedExtension(file: File, policy: SourceArchivePolicy): boolean {
  const name = file.name.toLowerCase();
  return policy.extensions.some((ext) => name.endsWith(ext.toLowerCase()));
}

export function NewTaskModal({ onClose, onCreated }: Props) {
  const [tab, setTab] = useState<"upload" | "git">("upload");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchFallback, setBranchFallback] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [auditFocus, setAuditFocus] = useState("");
  const [scanDuration, setScanDuration] = useState<string>("10"); // hours (custom mode default 10h)
  const [timeoutMode, setTimeoutMode] = useState<"custom" | "auto">("custom");
  const [agentMaxParallel, setAgentMaxParallel] = useState("3");
  const [enableDynamicVerify, setEnableDynamicVerify] = useState(false);
  const [enableDynamicExploit, setEnableDynamicExploit] = useState(false);
  const [sandboxCapacity, setSandboxCapacity] = useState<SandboxCapacity | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [archivePolicy, setArchivePolicy] = useState<SourceArchivePolicy>(DEFAULT_SOURCE_ARCHIVE_POLICY);
  const fileRef = useRef<HTMLInputElement>(null);
  const branchFetchSeq = useRef(0);

  // Multi-credential support: load all credentials and let user pick one.
  // When only 1 credential exists (or none), we hide the selector and fall
  // back to the backend's is_default behavior.
  const [credentials, setCredentials] = useState<LlmCredential[]>([]);
  const [credentialId, setCredentialId] = useState<string>("");
  useEffect(() => {
    let mounted = true;
    api.settings
      .listCredentials()
      .then((res) => {
        if (!mounted) return;
        setCredentials(res.credentials ?? []);
        const def = res.credentials?.find((c) => c.is_default);
        if (def) setCredentialId(def.id);
        else if (res.credentials && res.credentials.length > 0)
          setCredentialId(res.credentials[0].id);
      })
      .catch(() => {
        /* legacy service without /credentials endpoint — fall back to default */
      });
    return () => {
      mounted = false;
    };
  }, []);
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  // Capacity is a soft hint only (contract B3) — never blocks create.
  useEffect(() => {
    if (!enableDynamicVerify) {
      setSandboxCapacity(null);
      return;
    }
    let cancelled = false;
    api.sandbox
      .capacity()
      .then((c) => { if (!cancelled) setSandboxCapacity(c); })
      .catch(() => { if (!cancelled) setSandboxCapacity(null); });
    return () => { cancelled = true; };
  }, [enableDynamicVerify]);

  useEffect(() => {
    let mounted = true;
    api.tasks.sourceArchivePolicy()
      .then((policy) => { if (mounted) setArchivePolicy(policy); })
      .catch(() => { /* keep default policy for older services */ });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (tab !== "git") return;
    const url = gitUrl.trim();
    branchFetchSeq.current += 1;
    const seq = branchFetchSeq.current;
    setGitBranches([]);
    setBranchFallback(false);
    if (!isValidHttpGitUrl(url)) {
      setBranchLoading(false);
      return;
    }
    setBranchLoading(true);
    const timer = window.setTimeout(() => {
      api.git.branches(url)
        .then((res) => {
          if (branchFetchSeq.current !== seq) return;
          setGitBranches(res.branches ?? []);
          setBranchFallback(false);
          const preferred = res.default_branch && res.branches.includes(res.default_branch)
            ? res.default_branch
            : (res.default_branch ?? res.branches[0] ?? "");
          setGitBranch(preferred);
        })
        .catch(() => {
          if (branchFetchSeq.current !== seq) return;
          setGitBranches([]);
          setBranchFallback(true);
          setGitBranch("");
        })
        .finally(() => {
          if (branchFetchSeq.current === seq) setBranchLoading(false);
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [gitUrl, tab]);

  async function handleCreate() {
    setError("");
    setLoading(true);
    // Custom duration is shown in hours; backend expects scan_timeout in seconds.
    // In auto mode the backend forces the fixed 72h ceiling and ignores the value.
    const durationHours = Number.parseFloat(scanDuration);
    const scanTimeout =
      Number.isFinite(durationHours) && durationHours > 0 ? Math.round(durationHours * 3600) : undefined;
    const focus = auditFocus.trim();
    try {
      if (tab === "upload") {
        if (!file) return;
        if (!fileHasSupportedExtension(file, archivePolicy)) {
          setError(i18n.t("newTask.unsupportedArchive").replace("{extensions}", archivePolicy.extensions.join(", ")));
          return;
        }
        if (file.size > archivePolicy.max_bytes) {
          setError(i18n.t("newTask.uploadTooLarge").replace("{max}", String(archivePolicy.max_mb)));
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        if (credentialId) fd.append("credential_id", credentialId);
        if (displayName.trim()) fd.append("display_name", displayName.trim());
        if (focus) fd.append("audit_focus", focus);
        fd.append("timeout_mode", timeoutMode);
        if (timeoutMode === "custom" && scanTimeout !== undefined) fd.append("scan_timeout", String(scanTimeout));
        fd.append("agent_max_parallel", String(Math.max(1, Math.trunc(Number(agentMaxParallel) || 3))));
        if (enableDynamicVerify) fd.append("enable_dynamic_verify", "true");
        if (enableDynamicExploit) fd.append("enable_dynamic_exploit", "true");
        setUploadPct(0);
        await api.tasks.createWithProgress(fd, (pct) => setUploadPct(pct));
      } else {
        if (!gitUrl) return;
        await api.tasks.create({
          git_url: gitUrl,
          git_branch: gitBranch.trim() || undefined,
          project_name: gitUrl.split("/").pop(),
          display_name: displayName.trim() || undefined,
          credential_id: credentialId || undefined,
          audit_focus: focus || undefined,
          timeout_mode: timeoutMode,
          scan_timeout: timeoutMode === "custom" ? scanTimeout : undefined,
          agent_max_parallel: Math.max(1, Math.trunc(Number(agentMaxParallel) || 3)),
          enable_dynamic_verify: enableDynamicVerify || undefined,
          enable_dynamic_exploit: enableDynamicExploit || undefined,
        });
      }
      onCreated();
    } catch (err) {
      const e = err as Error & { code?: string; used?: number; limit?: number };
      if (e.code === "ERR_TASK_LIMIT_EXCEEDED" || e.message.includes("ERR_TASK_LIMIT_EXCEEDED") || e.message.includes("Task limit reached") || e.message.includes("任务创建上限")) {
        setError(i18n.t("taskLimit.exceeded")
          .replace("{used}", String(e.used ?? "N"))
          .replace("{limit}", String(e.limit ?? "N")));
      } else if (e.code === "ERR_TASK_UPLOAD_TOO_LARGE" || e.code === "ERR_SOURCE_ARCHIVE_TOO_LARGE") {
        setError(i18n.t("newTask.uploadTooLarge").replace("{max}", String(archivePolicy.max_mb)));
      } else if (e.code === "ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT") {
        setError(i18n.t("newTask.unsupportedArchive").replace("{extensions}", archivePolicy.extensions.join(", ")));
      } else if (e.code?.startsWith("ERR_SOURCE_ARCHIVE_")) {
        setError(i18n.t("newTask.invalidArchive"));
      } else if (e.code === "ERR_UPLOAD_GATEWAY_LIMIT" || e.message.includes("HTTP 413")) {
        setError(i18n.t("newTask.uploadGatewayLimit"));
      } else {
        setError(e.message || String(err));
      }
    } finally {
      setLoading(false);
      setUploadPct(null);
    }
  }

  const canSubmit = tab === "upload" ? !!file : !!gitUrl;

  // Track where mousedown originated so a text-selection drag that
  // happens to release on the overlay does NOT close the modal.
  // Only close when BOTH mousedown AND mouseup happen on the overlay itself.
  const overlayMouseDownRef = useRef(false);

  return (
    <div
      data-testid="new-task-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: "20px",
        boxSizing: "border-box",
      }}
      onMouseDown={(e) => {
        overlayMouseDownRef.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (
          overlayMouseDownRef.current &&
          e.target === e.currentTarget
        ) {
          onClose();
        }
        overlayMouseDownRef.current = false;
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          borderRadius: "10px",
          width: "480px",
          maxWidth: "100%",
          maxHeight: "calc(100vh - 40px)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: "1px solid var(--border)",
            flexShrink: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>{i18n.t("newTask.title")}</h2>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "18px",
              color: "var(--text-secondary)",
            }}
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-page)", flexShrink: 0 }}>
          {(["upload", "git"] as const).map((t) => (
            <button
              key={t}
              data-testid={`new-task-tab-${t}`}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: "10px",
                border: "none",
                background: "transparent",
                borderBottom: tab === t ? "2px solid var(--brand)" : "2px solid transparent",
                color: tab === t ? "var(--brand)" : "var(--text-secondary)",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {t === "upload" ? i18n.t("newTask.tabUpload") : i18n.t("newTask.tabGit")}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: "24px", overflowY: "auto", flex: 1, minHeight: 0 }}>
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
              {i18n.t("tasks.displayNameOptional")}
            </label>
            <input
              data-testid="new-task-display-name-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={i18n.t("tasks.displayNamePlaceholder")}
              maxLength={120}
              style={{ width: "100%", height: "40px", border: "1px solid var(--border)", borderRadius: "6px", padding: "0 10px", fontSize: "13px", background: "var(--bg-page)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }}
            />
          </div>

          {/* Credential picker — only shown when multiple credentials exist */}
          {credentials.length > 1 && (
            <div
              data-testid="new-task-credential-picker"
              style={{ marginBottom: "16px" }}
            >
              <label
                style={{
                  display: "block",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  marginBottom: "6px",
                }}
              >
                {i18n.t("newTask.credential")}
              </label>
              <select
                data-testid="new-task-credential-select"
                value={credentialId}
                onChange={(e) => setCredentialId(e.target.value)}
                style={{
                  width: "100%",
                  height: "40px",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  padding: "0 10px",
                  fontSize: "13px",
                  background: "var(--bg-page)",
                  color: "var(--text-primary)",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                {credentials.some((c) => c.scope === "global" || !c.scope) && (
                  <optgroup label="全局凭证">
                    {credentials.filter((c) => c.scope === "global" || !c.scope).map((c) => (
                      <option key={c.id} value={c.id}>
                        {(c.label || c.provider) + " — " + c.model_id + (c.is_default ? " ★" : "")}
                      </option>
                    ))}
                  </optgroup>
                )}
                {credentials.some((c) => c.scope === "personal") && (
                  <optgroup label="我的凭证">
                    {credentials.filter((c) => c.scope === "personal").map((c) => (
                      <option key={c.id} value={c.id}>
                        {(c.label || c.provider) + " — " + c.model_id + (c.is_default ? " ★" : "")}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
          )}

          {tab === "upload" ? (
            <div>
              <div
                data-testid="upload-dropzone"
                onClick={() => fileRef.current?.click()}
                style={{
                  border: `2px dashed ${file ? "var(--brand)" : "var(--border)"}`,
                  borderRadius: "8px",
                  padding: "32px",
                  textAlign: "center",
                  cursor: "pointer",
                  background: file ? "var(--bg-error)" : "var(--bg-page)",
                  transition: "all 0.15s",
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const dropped = e.dataTransfer.files[0];
                  if (dropped) {
                    setError("");
                    setFile(dropped);
                  }
                }}
              >
                <div style={{ fontSize: "32px", marginBottom: "8px" }}>📦</div>
                {file ? (
                  <p style={{ fontSize: "13px", fontWeight: 600, color: "var(--brand)", margin: 0 }}>
                    {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
                  </p>
                ) : (
                  <>
                    <p style={{ fontSize: "13px", fontWeight: 500, margin: "0 0 4px", color: "var(--text-primary)" }}>
                      {i18n.t("newTask.dropzone")}
                    </p>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: 0 }}>
                      {i18n.t("newTask.supportedArchives")
                        .replace("{extensions}", archivePolicy.extensions.join(", "))
                        .replace("{max}", String(archivePolicy.max_mb))}
                    </p>
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept={archivePolicy.accept}
                style={{ display: "none" }}
                onChange={(e) => {
                  const selected = e.target.files?.[0];
                  if (selected) {
                    setError("");
                    setFile(selected);
                  }
                }}
              />

              {/* Upload progress bar — only visible during active upload */}
              {uploadPct !== null && (
                <div
                  data-testid="upload-progress"
                  data-pct={uploadPct}
                  style={{ marginTop: "14px" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: "6px",
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                    }}
                  >
                    <span>{i18n.t("newTask.uploading")}</span>
                    <span
                      style={{
                        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: 600,
                        color:
                          uploadPct >= 100
                            ? "var(--sev-low)"
                            : "var(--text-primary)",
                      }}
                    >
                      {uploadPct >= 100
                        ? i18n.t("newTask.processing")
                        : `${uploadPct}%`}
                    </span>
                  </div>
                  <div
                    style={{
                      width: "100%",
                      height: "6px",
                      borderRadius: "3px",
                      background: "var(--border)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      data-testid="upload-progress-bar"
                      style={{
                        width: `${Math.max(uploadPct, 2)}%`,
                        height: "100%",
                        background:
                          uploadPct >= 100
                            ? "var(--sev-low)"
                            : "var(--brand)",
                        transition: "width 0.2s ease-out, background 0.2s",
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
                  {i18n.t("newTask.gitUrl")}
                </label>
                <input
                  data-testid="git-url-input"
                  type="url"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder={i18n.t("newTask.gitPlaceholder")}
                  style={{
                    width: "100%",
                    height: "40px",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    padding: "0 12px",
                    fontSize: "13px",
                    background: "var(--bg-page)",
                    color: "var(--text-primary)",
                    outline: "none",
                  }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
                  {i18n.t("newTask.branch")}
                </label>
                {branchLoading ? (
                  <div data-testid="git-branch-loading" style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "10px 0" }}>
                    {i18n.t("newTask.branchLoading")}
                  </div>
                ) : gitBranches.length > 0 ? (
                  <select
                    data-testid="git-branch-select"
                    value={gitBranch}
                    onChange={(e) => setGitBranch(e.target.value)}
                    style={{
                      width: "100%",
                      height: "40px",
                      border: "1px solid var(--border)",
                      borderRadius: "6px",
                      padding: "0 12px",
                      fontSize: "13px",
                      background: "var(--bg-page)",
                      color: "var(--text-primary)",
                      outline: "none",
                    }}
                  >
                    {gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                  </select>
                ) : (
                  <>
                    <input
                      data-testid="git-branch-input"
                      type="text"
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                      placeholder={branchFallback ? i18n.t("newTask.branchManualPlaceholder") : i18n.t("newTask.branchAutoPlaceholder")}
                      style={{
                        width: "100%",
                        height: "40px",
                        border: "1px solid var(--border)",
                        borderRadius: "6px",
                        padding: "0 12px",
                        fontSize: "13px",
                        background: "var(--bg-page)",
                        color: "var(--text-primary)",
                        outline: "none",
                      }}
                    />
                    {branchFallback ? <div data-testid="git-branch-fallback" style={{ marginTop: 6, fontSize: "12px", color: "var(--text-secondary)" }}>{i18n.t("newTask.branchFallback")}</div> : null}
                  </>
                )}
              </div>
            </div>
          )}

          {/* VulnForge scan parameters */}
          <div style={{ marginTop: "20px", paddingTop: "20px", borderTop: "1px solid var(--divider)" }}>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
                {i18n.t("newTask.auditFocus")}
              </label>
              <textarea
                data-testid="new-task-audit-focus"
                value={auditFocus}
                onChange={(e) => setAuditFocus(e.target.value)}
                placeholder={i18n.t("newTask.auditFocusPlaceholder")}
                rows={3}
                maxLength={2000}
                style={{ width: "100%", border: "1px solid var(--border)", borderRadius: "6px", padding: "8px 10px", fontSize: "13px", background: "var(--bg-page)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "8px" }}>
                {i18n.t("newTask.scanDuration")}
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: "10px" }}>
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    padding: "12px",
                    border: `1px solid ${timeoutMode === "custom" ? "var(--brand)" : "var(--border)"}`,
                    borderRadius: "8px",
                    background: timeoutMode === "custom" ? "var(--bg-error)" : "var(--bg-page)",
                    cursor: "pointer",
                  }}
                >
                  <input data-testid="timeout-mode-custom" type="radio" name="timeout-mode" checked={timeoutMode === "custom"} onChange={() => setTimeoutMode("custom")} style={{ marginTop: "2px" }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 650, color: "var(--text-primary)" }}>{i18n.t("newTask.timeoutCustom")}</span>
                    <span style={{ display: "block", marginTop: "4px", fontSize: "11px", lineHeight: 1.45, color: "var(--text-secondary)" }}>{i18n.t("newTask.timeoutCustomDesc")}</span>
                    {timeoutMode === "custom" ? (
                      <span style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" }}>
                        <input data-testid="new-task-scan-duration" type="number" min={0.5} max={72} step={0.5} value={scanDuration} onChange={(e) => setScanDuration(e.target.value)} style={{ width: "72px", height: "32px", border: "1px solid var(--border)", borderRadius: "6px", padding: "0 8px", fontSize: "13px", background: "var(--bg-card)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }} />
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{i18n.t("newTask.hoursDefault")}</span>
                      </span>
                    ) : null}
                  </span>
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    padding: "12px",
                    border: `1px solid ${timeoutMode === "auto" ? "var(--brand)" : "var(--border)"}`,
                    borderRadius: "8px",
                    background: timeoutMode === "auto" ? "var(--bg-error)" : "var(--bg-page)",
                    cursor: "pointer",
                  }}
                >
                  <input data-testid="timeout-mode-auto" type="radio" name="timeout-mode" checked={timeoutMode === "auto"} onChange={() => setTimeoutMode("auto")} style={{ marginTop: "2px" }} />
                  <span>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 650, color: "var(--text-primary)" }}>{i18n.t("newTask.timeoutAuto")}</span>
                    <span style={{ display: "block", marginTop: "4px", fontSize: "11px", lineHeight: 1.45, color: "var(--text-secondary)" }}>
                      {i18n.t("newTask.timeoutAutoDesc")}{enableDynamicVerify ? ` ${i18n.t("newTask.dynamicDurationHint")}` : ""}
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div style={{ marginBottom: "4px" }} data-testid="new-task-agent-parallel-field">
              <label style={{ display: "block", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)", marginBottom: "8px" }}>
                {i18n.t("newTask.agentMaxParallel")}
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <input
                  data-testid="new-task-agent-max-parallel"
                  type="number"
                  min={1}
                  step={1}
                  value={agentMaxParallel}
                  onChange={(e) => setAgentMaxParallel(e.target.value)}
                  onBlur={() => {
                    const n = Math.max(1, Math.trunc(Number(agentMaxParallel) || 1));
                    setAgentMaxParallel(String(n));
                  }}
                  style={{ width: "76px", height: "36px", border: "1px solid var(--border)", borderRadius: "6px", padding: "0 8px", fontSize: "14px", fontWeight: 600, textAlign: "center", fontVariantNumeric: "tabular-nums", background: "var(--bg-card)", color: "var(--text-primary)", outline: "none", boxSizing: "border-box" }}
                />
                <span style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>{i18n.t("newTask.agentMaxParallelRange")}</span>
              </div>
              <p style={{ margin: "8px 0 0", fontSize: "11.5px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                {i18n.t("newTask.agentMaxParallelHint")}
              </p>
            </div>

            {/* Dynamic capability (Beta) */}
            <div style={{ marginTop: "16px", border: "1px solid var(--border)", borderRadius: "10px", background: "var(--bg-page)", padding: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
                <span style={{ padding: "2px 6px", borderRadius: "5px", background: "var(--bg-error)", color: "var(--brand)", fontSize: "10px", fontWeight: 750, textTransform: "uppercase" }}>Beta</span>
                <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--text-primary)" }}>{i18n.t("newTask.dynamicTitle")}</span>
                <span style={{ marginLeft: "auto", fontSize: "11px", fontWeight: 650, color: enableDynamicVerify ? "var(--status-completed)" : "var(--text-secondary)" }}>
                  {i18n.t(enableDynamicVerify ? "newTask.sandboxEnabled" : "newTask.optional")}
                </span>
              </div>
              <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.45, marginBottom: "10px" }}>{i18n.t("newTask.dynamicSubtitle")}</div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "10px", border: "1px solid var(--border)", borderRadius: "8px", background: "var(--bg-card)", cursor: "pointer" }}>
                  <input data-testid="enable-dynamic-verify" type="checkbox" checked={enableDynamicVerify} onChange={(e) => { const on = e.target.checked; setEnableDynamicVerify(on); if (!on) setEnableDynamicExploit(false); }} style={{ marginTop: "2px" }} />
                  <span>
                    <span style={{ display: "block", fontSize: "13px", fontWeight: 650, color: "var(--text-primary)" }}>{i18n.t("newTask.dynamicVerify")}</span>
                    <span style={{ display: "block", marginTop: "3px", fontSize: "11px", lineHeight: 1.45, color: "var(--text-secondary)" }}>{i18n.t("newTask.dynamicVerifyDesc")}</span>
                  </span>
                </label>
                <label
                  title={enableDynamicVerify ? undefined : i18n.t("newTask.dynamicExploitNeedsVerify")}
                  style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "10px", border: `1px ${enableDynamicVerify ? "solid" : "dashed"} var(--border)`, borderRadius: "8px", background: enableDynamicVerify ? "var(--bg-card)" : "transparent", cursor: enableDynamicVerify ? "pointer" : "not-allowed", opacity: enableDynamicVerify ? 1 : 0.6 }}
                >
                  <input data-testid="enable-dynamic-exploit" type="checkbox" checked={enableDynamicExploit} disabled={!enableDynamicVerify} onChange={(e) => setEnableDynamicExploit(e.target.checked)} style={{ marginTop: "2px" }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 650, color: enableDynamicVerify ? "var(--text-primary)" : "var(--text-secondary)" }}>
                      {i18n.t("newTask.dynamicExploit")}
                      {!enableDynamicVerify ? <span style={{ fontSize: "10px", fontWeight: 500 }}>{i18n.t("newTask.dynamicExploitNeedsVerify")}</span> : null}
                    </span>
                    <span style={{ display: "block", marginTop: "3px", fontSize: "11px", lineHeight: 1.45, color: "var(--text-secondary)" }}>{i18n.t("newTask.dynamicExploitDesc")}</span>
                  </span>
                </label>
                <div style={{ fontSize: "11px", color: "var(--brand, var(--sev-medium))", background: "var(--bg-warning, rgba(180,83,9,0.08))", border: "1px solid var(--border-warning, rgba(180,83,9,0.3))", borderRadius: "7px", padding: "8px 10px", lineHeight: 1.5 }}>
                  {i18n.t("newTask.dynamicHint")}
                </div>
                {enableDynamicVerify && sandboxCapacity && sandboxCapacity.available_now === false ? (
                  <div
                    data-testid="sandbox-queue-hint"
                    style={{
                      fontSize: "12px",
                      color: "var(--sev-medium)",
                      background: "rgba(180,83,9,0.1)",
                      border: "1px solid rgba(180,83,9,0.35)",
                      borderRadius: "7px",
                      padding: "9px 11px",
                      lineHeight: 1.5,
                    }}
                  >
                    {i18n.t("newTask.willQueue")}
                    {sandboxCapacity.queue_depth > 0
                      ? ` (${i18n.t("newTask.queueDepth").replace("{n}", String(sandboxCapacity.queue_depth))})`
                      : ""}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {error && <p style={{ color: "var(--brand)", fontSize: "13px", margin: "12px 0 0" }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <button
            data-testid="start-scan-btn"
            onClick={handleCreate}
            disabled={!canSubmit || loading}
            style={{
              width: "100%",
              padding: "12px",
              background: !canSubmit || loading ? "var(--bg-disabled)" : "var(--brand)",
              color: !canSubmit || loading ? "var(--text-secondary)" : "var(--btn-primary-text)",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: !canSubmit || loading ? "not-allowed" : "pointer",
            }}
          >
            {loading
              ? uploadPct !== null && uploadPct < 100
                ? `${i18n.t("newTask.uploading")} ${uploadPct}%`
                : i18n.t("newTask.submitting")
              : i18n.t("newTask.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
