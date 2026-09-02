import { useEffect, useState, type CSSProperties } from "react";
import { api, type SystemConfig } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useEdition } from "../../../shared/hooks/useEdition.js";
import { AdminPageHeader, adminCardStyle } from "../layout.js";

export function SystemPage() {
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  const [config, setConfig] = useState<SystemConfig | null>(null);
  const [maxParallel, setMaxParallel] = useState<number | "">(3);
  const [uploadMb, setUploadMb] = useState(500);
  const [idleMinutes, setIdleMinutes] = useState<number | "">(10080);
  const { hasDynamicVerification } = useEdition();
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
        setIdleMinutes((r.config as { sandbox_idle_release_minutes?: number }).sandbox_idle_release_minutes ?? 10080);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const ceiling = config?.source_archive_upload_ceiling_mb ?? config?.upload_gateway_limit_mb ?? 2048;

  async function saveParallel(v: number) {
    const n = Math.max(1, Math.trunc(Number(v) || 1));
    setSaving(true);
    setMsg("");
    setErr("");
    try {
      await api.settings.updateSystemConfig({ max_parallel_scan: n });
      setMsg(i18n.t("admin.system.parallelSaved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }


  async function saveIdleMinutes() {
    const n = Math.trunc(Number(idleMinutes));
    if (!Number.isInteger(n) || n < 1 || n > 43200) {
      setErr(i18n.t("admin.system.idleMinutesInvalid"));
      return;
    }
    setSaving(true);
    setMsg("");
    setErr("");
    try {
      await api.settings.updateSystemConfig({ sandbox_idle_release_minutes: n });
      setMsg(i18n.t("admin.system.idleMinutesSaved"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

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
        <div style={{ color: "var(--status-completed)", marginBottom: 12, fontSize: 13 }}>{msg}</div>
      ) : null}

      <section style={adminCardStyle} data-testid="admin-card-engine">
        <h3 style={cardTitle}>
          <Icon name="sliders" size={18} style={{ color: "var(--text-secondary)" }} />
          {i18n.t("admin.system.engineTitle")}
        </h3>
        <p style={cardDesc}>{i18n.t("admin.system.engineDesc")}</p>
        <label style={labelStyle}>{i18n.t("admin.system.parallelLabel")}</label>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
          <input
            type="number"
            data-testid="admin-max-parallel-input"
            min={1}
            step={1}
            value={maxParallel}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                setMaxParallel("" as unknown as number);
                return;
              }
              const n = Number(raw);
              if (Number.isFinite(n)) setMaxParallel(Math.trunc(n));
            }}
            onBlur={() => {
              const n = Math.max(1, Math.trunc(Number(maxParallel) || 1));
              setMaxParallel(n);
              void saveParallel(n);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const n = Math.max(1, Math.trunc(Number(maxParallel) || 1));
                setMaxParallel(n);
                void saveParallel(n);
              }
            }}
            style={{
              width: 96,
              height: 36,
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "0 10px",
              fontSize: 16,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              background: "var(--bg-page)",
              color: "var(--text-primary)",
              textAlign: "center",
            }}
          />
          <span style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
            {i18n.t("admin.system.parallelHint")}
          </span>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 18px" }}>
          {i18n.t("admin.system.agentParallelHint")}
        </p>
      </section>

      {hasDynamicVerification ? (
      <section style={adminCardStyle} data-testid="admin-card-sandbox-ttl">
        <h3 style={cardTitle}>
          <Icon name="clock" size={18} style={{ color: "var(--text-secondary)" }} />
          {i18n.t("admin.system.idleMinutesTitle")}
        </h3>
        <p style={cardDesc}>{i18n.t("admin.system.idleMinutesDesc")}</p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <input
            type="number"
            data-testid="admin-idle-minutes"
            min={1}
            max={43200}
            step={1}
            value={idleMinutes}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                setIdleMinutes("" as unknown as number);
                return;
              }
              const n = Number(raw);
              if (Number.isFinite(n)) setIdleMinutes(Math.trunc(n));
            }}
            style={{ width: 100, height: 36, border: "1px solid var(--border)", borderRadius: 6, padding: "0 10px", background: "var(--bg-page)", color: "var(--text-primary)" }}
          />
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{i18n.t("admin.system.idleMinutesUnit")}</span>
          <button type="button" data-testid="admin-save-idle-minutes" disabled={saving} onClick={() => void saveIdleMinutes()} style={btnPrimary}>
            {i18n.t("admin.system.save")}
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
          {i18n.t("admin.system.idleMinutesHint")}
        </p>
      </section>
      ) : null}

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
