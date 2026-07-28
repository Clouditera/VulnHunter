import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { useSystemStatus } from "../../auth/hooks/useSystemStatus.js";
import { AdminPageHeader, adminCardStyle } from "../layout.js";

export function LicensePage() {
  const qc = useQueryClient();
  const { data: status, refetch } = useSystemStatus();
  const [, tick] = useState(0);
  useEffect(() => i18n.onChange(() => tick((n) => n + 1)), []);
  const [cert, setCert] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);

  const license = status?.license;
  const machine = status?.installation_id ?? license?.machine_code ?? "";

  async function copyMachine() {
    try {
      await navigator.clipboard.writeText(machine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setOk(false);
    try {
      await api.system.activate(cert.trim());
      setOk(true);
      setCert("");
      await refetch();
      qc.invalidateQueries({ queryKey: ["system-status"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div data-testid="admin-license-page">
      <AdminPageHeader
        page={i18n.t("admin.nav.license")}
        title={i18n.t("settings.license.title")}
        desc={i18n.t("settings.license.desc")}
      />

      <section style={adminCardStyle} data-testid="admin-license-current">
        <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600 }}>{i18n.t("admin.license.current")}</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Row label={i18n.t("settings.license.status")}>
            <span
              data-testid="admin-license-status"
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: license?.status === "active" ? "rgba(22,163,74,0.12)" : "rgba(220,38,38,0.1)",
                color: license?.status === "active" ? "#16a34a" : "var(--brand)",
              }}
            >
              {license?.status ?? "—"}
            </span>
          </Row>
          <Row label={i18n.t("settings.license.currentVersion")}>{status?.version?.version ?? "—"}</Row>
          <Row label={i18n.t("settings.license.licensedVersion")}>{license?.licensed_version ?? "—"}</Row>
          <Row label={i18n.t("settings.license.expires")}>{license?.expires_at ?? "—"}</Row>
          <Row label={i18n.t("settings.license.remaining")}>
            {license?.days_remaining != null ? String(license.days_remaining) : "—"}
          </Row>
          <Row label={i18n.t("settings.license.installId")}>
            <code style={{ fontSize: 12 }}>{machine || "—"}</code>
          </Row>
        </div>
      </section>

      <section style={adminCardStyle} data-testid="admin-license-update">
        <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600 }}>{i18n.t("admin.license.update")}</h3>
        <form onSubmit={(e) => void activate(e)}>
          <textarea
            data-testid="admin-license-cert"
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            rows={5}
            placeholder={i18n.t("activate.placeholder")}
            style={{
              width: "100%",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 12,
              fontFamily: "SF Mono, JetBrains Mono, monospace",
              background: "var(--bg-page)",
              color: "var(--text-primary)",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button
              type="submit"
              data-testid="admin-license-activate"
              disabled={loading || !cert.trim()}
              style={{
                padding: "8px 16px",
                border: "none",
                borderRadius: 6,
                background: loading || !cert.trim() ? "var(--bg-disabled)" : "var(--brand)",
                color: "var(--btn-primary-text)",
                fontSize: 13,
                fontWeight: 600,
                cursor: loading || !cert.trim() ? "not-allowed" : "pointer",
              }}
            >
              {loading ? i18n.t("activate.activating") : i18n.t("activate.submit")}
            </button>
            <button
              type="button"
              data-testid="admin-copy-machine"
              onClick={() => void copyMachine()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 12px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-card)",
                color: "var(--text-primary)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <Icon name="copy" size={13} />
              {copied ? i18n.t("activate.copied") : i18n.t("activate.copyMachineCode")}
            </button>
          </div>
          {error ? <div style={{ color: "var(--brand)", marginTop: 10, fontSize: 13 }}>{error}</div> : null}
          {ok ? <div style={{ color: "#16a34a", marginTop: 10, fontSize: 13 }}>{i18n.t("activate.success")}</div> : null}
        </form>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
      <div style={{ width: 140, color: "var(--text-secondary)", flexShrink: 0 }}>{label}</div>
      <div style={{ color: "var(--text-primary)", minWidth: 0 }}>{children}</div>
    </div>
  );
}
