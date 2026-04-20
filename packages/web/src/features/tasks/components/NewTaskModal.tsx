import { useState, useRef } from "react";
import { api } from "../../../shared/api/client.js";

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export function NewTaskModal({ onClose, onCreated }: Props) {
  const [tab, setTab] = useState<"upload" | "git">("upload");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleCreate() {
    setError("");
    setLoading(true);
    try {
      if (tab === "upload") {
        if (!file) return;
        const fd = new FormData();
        fd.append("file", file);
        await api.tasks.create(fd);
      } else {
        if (!gitUrl) return;
        await api.tasks.create({ git_url: gitUrl, project_name: gitUrl.split("/").pop() });
      }
      onCreated();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = tab === "upload" ? !!file : !!gitUrl;

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
      onClick={(e) => e.target === e.currentTarget && onClose()}
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
          <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700 }}>New Security Scan</h2>
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
              {t === "upload" ? "Upload" : "Git URL"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: "24px" }}>
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
                  background: file ? "#fef2f2" : "var(--bg-page)",
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
                      Drop project archive here
                    </p>
                    <p style={{ fontSize: "12px", color: "var(--text-secondary)", margin: 0 }}>
                      or click to browse · .zip .tar.gz .tar.bz2
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
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "block", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "6px" }}>
                  Repository URL
                </label>
                <input
                  data-testid="git-url-input"
                  type="url"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/user/repo.git"
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
                  Branch (optional)
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
              background: !canSubmit || loading ? "#e5e5e5" : "var(--brand)",
              color: !canSubmit || loading ? "var(--text-secondary)" : "#fff",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: !canSubmit || loading ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Starting…" : "Start Scan"}
          </button>
        </div>
      </div>
    </div>
  );
}
