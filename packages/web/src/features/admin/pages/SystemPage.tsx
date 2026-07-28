import { useEffect, useState, type CSSProperties } from "react";
import { api, type SystemConfig } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { AdminPageHeader, adminCardStyle } from "../layout.js";

export function SystemPage() {
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [maxParallel, setMaxParallel] = useState(3);
  const [uploadMb, setUploadMb] = useState(500);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.settings
      .getSystemConfig()
      .then((r) => {
        setConfig(r.config);
        setMaxParallel(r.config.max_parallel_scan ?? 3);
        setUploadMb(r.config.source_archive_upload_max_mb ?? r.config.upload_zip_max_mb ?? 500);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const ceiling = config?.source_archive_upload_ceiling_mb ?? config?.upload_gateway_limit_mb ?? 2048;

  async function saveUpload() {
    setSaving(true);
    setMsg("");
    setErr("");
    try {
      await api.settings.updateSystemConfig({ source_archive_upload_max_mb: uploadMb });
      setMsg(i18n.t("admin.system.saved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="admin-system-page">
      <AdminPageHeader
        page={i18n.t("admin.nav.system")}
        title={i18n.t("admin.system.title")}
        desc={i18n.t("admin.system.desc")}
      />
      {err ? (
        <div style={{ color: "var(--brand)", marginBottom: 12, fontSize: 13 }}>{err}</div>
      ) : null}
      {msg ? (
        <div style={{ color: "#16a34a", marginBottom: 12, fontSize: 13 }}>{msg}</div>
      ) : null}

      <section style={adminCardStyle} data-testid="admin-card-engine">
        <h3 style={cardTitle}>
          <Icon name="sliders" size={18} style={{ color: "var(--text-secondary)" }} />
          {i18n.t("admin.system.engineTitle")}
        </h3>
        <p style={cardDesc}>{i18n.t("admin.system.engineDesc")}</p>
        <label style={labelStyle}>{i18n.t("settings.engine.maxParallel")}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
          <input
            type="range"
            data-testid="admin-max-parallel-slider"
            min={1}
            max={10}
            value={maxParallel}
            onChange={(e) => setMaxParallel(Number(e.target.value))}
            onPointerUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              setMaxParallel(v);
              void (async () => {
                setSaving(true);
                setMsg("");
                setErr("");
                try {
                  await api.settings.updateSystemConfig({ max_parallel_scan: v });
                  setMsg(i18n.t("admin.system.saved"));
                } catch (er) {
                  setErr(er instanceof Error ? er.message : String(er));
                } finally {
                  setSaving(false);
                }
              })();
            }}
            style={{ flex: 1, accentColor: "var(--brand)" }}
          />
          <span data-testid="admin-max-parallel-value" style={{ fontSize: 20, fontWeight: 600, minWidth: 24, textAlign: "center" }}>
            {maxParallel}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
          {i18n.t("admin.system.agentParallelHint")}
        </p>
      </section>

      <section style={adminCardStyle} data-testid="admin-card-upload">
        <h3 style={cardTitle}>
          <Icon name="upload" size={18} style={{ color: "var(--text-secondary)" }} />
          {i18n.t("settings.upload.sourceArchiveMax")}
        </h3>
        <p style={cardDesc}>{i18n.t("settings.upload.sourceArchiveDesc")}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <input
            type="number"
            data-testid="admin-upload-mb"
            min={1}
            max={ceiling}
            value={uploadMb}
            onChange={(e) => setUploadMb(Number(e.target.value))}
            style={{ width: 100, height: 36, border: "1px solid var(--border)", borderRadius: 6, padding: "0 10px", background: "var(--bg-page)", color: "var(--text-primary)" }}
          />
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>MB</span>
          <button type="button" data-testid="admin-save-upload" disabled={saving} onClick={() => void saveUpload()} style={btnPrimary}>
            {i18n.t("admin.system.save")}
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
          {i18n.t("admin.system.uploadCeiling").replace("{n}", String(ceiling))}
        </p>
      </section>
    </div>
  );
}

const cardTitle: CSSProperties = {
  margin: "0 0 4px",
  fontSize: 15,
  fontWeight: 600,
  display: "flex",
  alignItems: "center",
  gap: 8,
  color: "var(--text-primary)",
};
const cardDesc: CSSProperties = {
  margin: "0 0 16px",
  fontSize: 13,
  color: "var(--text-secondary)",
};
const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  marginBottom: 8,
};
const btnPrimary: CSSProperties = {
  padding: "7px 14px",
  border: "none",
  borderRadius: 6,
  background: "var(--brand)",
  color: "var(--btn-primary-text)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
