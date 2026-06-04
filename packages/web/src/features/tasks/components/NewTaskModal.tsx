import { useState, useRef, useEffect } from "react";
import { api, type LlmCredential } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function NewTaskModal({ onClose, onCreated }: Props) {
  const [tab, setTab] = useState<"upload" | "git">("upload");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [displayName, setDisplayName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function handleCreate() {
    setError("");
    setLoading(true);
    try {
      if (tab === "upload") {
        if (!file) return;
        const fd = new FormData();
        fd.append("file", file);
        if (credentialId) fd.append("credential_id", credentialId);
        if (displayName.trim()) fd.append("display_name", displayName.trim());
        setUploadPct(0);
        await api.tasks.createWithProgress(fd, (pct) => setUploadPct(pct));
      } else {
        if (!gitUrl) return;
        await api.tasks.create({
          git_url: gitUrl,
          project_name: gitUrl.split("/").pop(),
          display_name: displayName.trim() || undefined,
          credential_id: credentialId || undefined,
        });
      }
      onCreated();
    } catch (err) {
      setError(String(err));
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
          boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: "1px solid var(--border)",
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
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-page)" }}>
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
        <div style={{ padding: "24px" }}>
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
                  if (dropped) setFile(dropped);
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
                      .zip .tar.gz .tar.bz2
                    </p>
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".zip,.tar.gz,.tar.bz2"
                style={{ display: "none" }}
                onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])}
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
                <input
                  data-testid="git-branch-input"
                  type="text"
                  value={gitBranch}
                  onChange={(e) => setGitBranch(e.target.value)}
                  placeholder="main"
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
            </div>
          )}

          {error && <p style={{ color: "var(--brand)", fontSize: "13px", margin: "12px 0 0" }}>{error}</p>}
        </div>

        {/* Footer */}
        <div style={{ padding: "0 24px 24px" }}>
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
