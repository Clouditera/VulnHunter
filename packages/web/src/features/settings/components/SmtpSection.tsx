/**
 * Admin SMTP configuration — registration / password-reset mail.
 * Contract A4: GET/PUT /api/settings/smtp + test endpoint.
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--divider)",
  borderRadius: "10px",
  padding: "20px 22px",
  marginBottom: "18px",
};
const TITLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "15px",
  fontWeight: 700,
  margin: "0 0 4px",
};
const DESC: CSSProperties = {
  fontSize: "12.5px",
  color: "var(--text-secondary)",
  margin: "0 0 16px",
  lineHeight: 1.55,
};
const LABEL: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 500,
  marginBottom: "4px",
  color: "var(--text-primary)",
};
const INPUT: CSSProperties = {
  width: "100%",
  height: "36px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  padding: "0 10px",
  fontSize: "13px",
  background: "var(--bg-page)",
  color: "var(--text-primary)",
  outline: "none",
};
const BTN_PRIMARY: CSSProperties = {
  height: "34px",
  padding: "0 14px",
  borderRadius: "6px",
  border: "none",
  background: "var(--brand)",
  color: "var(--btn-primary-text)",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
};
const BTN_GHOST: CSSProperties = {
  height: "34px",
  padding: "0 14px",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontWeight: 500,
  cursor: "pointer",
};

type Encryption = "none" | "ssl" | "starttls";

export function SmtpSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["settings", "smtp"], queryFn: () => api.settingsSmtp.get() });

  const [host, setHost] = useState("");
  const [port, setPort] = useState("465");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [encryption, setEncryption] = useState<Encryption>("ssl");
  const [testTo, setTestTo] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!data || hydrated) return;
    setHost(data.host ?? "");
    setPort(String(data.port ?? 465));
    setUsername(data.username ?? "");
    setFromAddress(data.from_address ?? "");
    setEncryption((data.encryption as Encryption) || "ssl");
    setPassword(""); // never hydrate password
    setHydrated(true);
  }, [data, hydrated]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.settingsSmtp.put({
        host: host.trim(),
        port: Number(port) || 465,
        username: username.trim(),
        password: password || undefined,
        from_address: fromAddress.trim(),
        encryption,
      }),
    onSuccess: () => {
      setMsg({ kind: "ok", text: i18n.t("settings.smtp.saved") });
      setPassword("");
      qc.invalidateQueries({ queryKey: ["settings", "smtp"] });
    },
    onError: (err: Error) => setMsg({ kind: "err", text: err.message || i18n.t("settings.smtp.saveFailed") }),
  });

  const testMut = useMutation({
    mutationFn: () => api.settingsSmtp.test(testTo.trim()),
    onSuccess: () => {
      setMsg({ kind: "ok", text: i18n.t("settings.smtp.testOk") });
      qc.invalidateQueries({ queryKey: ["settings", "smtp"] });
    },
    onError: (err: Error) => setMsg({ kind: "err", text: err.message || i18n.t("settings.smtp.testFailed") }),
  });

  function onSave(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    saveMut.mutate();
  }

  if (isLoading && !hydrated) {
    return (
      <section style={CARD} data-testid="settings-card-smtp">
        <p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("common.loading")}</p>
      </section>
    );
  }

  const configured = data?.configured === true;

  return (
    <section style={CARD} data-testid="settings-card-smtp">
      <h3 style={TITLE}>
        <Icon name="send" size={18} style={{ color: "var(--text-secondary)" }} />
        <span>{i18n.t("settings.smtp.title")}</span>
      </h3>
      <p style={DESC}>{i18n.t("settings.smtp.desc")}</p>

      <form onSubmit={onSave}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px" }}>
          <div>
            <label style={LABEL}>{i18n.t("settings.smtp.host")}</label>
            <input data-testid="smtp-host" style={INPUT} value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.company.com" />
          </div>
          <div>
            <label style={LABEL}>{i18n.t("settings.smtp.port")}</label>
            <input data-testid="smtp-port" style={INPUT} value={port} onChange={(e) => setPort(e.target.value)} placeholder="465" />
          </div>
          <div>
            <label style={LABEL}>{i18n.t("settings.smtp.encryption")}</label>
            <select
              data-testid="smtp-encryption"
              style={INPUT}
              value={encryption}
              onChange={(e) => setEncryption(e.target.value as Encryption)}
            >
              <option value="ssl">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
              <option value="none">{i18n.t("settings.smtp.encNone")}</option>
            </select>
          </div>
          <div>
            <label style={LABEL}>{i18n.t("settings.smtp.username")}</label>
            <input data-testid="smtp-username" style={INPUT} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="noreply@company.com" />
          </div>
          <div>
            <label style={LABEL}>{i18n.t("settings.smtp.password")}</label>
            <input
              data-testid="smtp-password"
              style={INPUT}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={data?.password_configured ? i18n.t("settings.smtp.passwordKeep") : "••••••••"}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label style={LABEL}>{i18n.t("settings.smtp.from")}</label>
            <input data-testid="smtp-from" style={INPUT} value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="VulnHunter <noreply@company.com>" />
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "16px", flexWrap: "wrap", alignItems: "center" }}>
          <button data-testid="smtp-save" type="submit" disabled={saveMut.isPending} style={BTN_PRIMARY}>
            {saveMut.isPending ? i18n.t("common.saving") : i18n.t("settings.smtp.save")}
          </button>
          <input
            data-testid="smtp-test-to"
            style={{ ...INPUT, width: "220px" }}
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder={i18n.t("settings.smtp.testToPlaceholder")}
          />
          <button
            data-testid="smtp-test"
            type="button"
            disabled={testMut.isPending || !testTo.trim()}
            onClick={() => { setMsg(null); testMut.mutate(); }}
            style={BTN_GHOST}
          >
            {testMut.isPending ? i18n.t("settings.smtp.testing") : i18n.t("settings.smtp.test")}
          </button>
        </div>
      </form>

      <div
        data-testid="smtp-status"
        style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "14px", fontSize: "12.5px", color: "var(--text-secondary)" }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: configured ? "var(--status-completed, var(--status-completed))" : "var(--text-secondary)",
          }}
        />
        {configured
          ? i18n.t("settings.smtp.statusConfigured")
          : i18n.t("settings.smtp.statusMissing")}
        {data?.last_tested_at
          ? ` · ${data.last_test_ok ? i18n.t("settings.smtp.lastTestOk") : i18n.t("settings.smtp.lastTestFail")} (${new Date(data.last_tested_at).toLocaleString()})`
          : null}
      </div>

      {msg ? (
        <div
          data-testid="smtp-msg"
          style={{
            marginTop: "12px",
            fontSize: "12.5px",
            color: msg.kind === "ok" ? "var(--status-completed, var(--status-completed))" : "var(--brand)",
          }}
        >
          {msg.text}
        </div>
      ) : null}

      <div style={{ marginTop: "18px", paddingTop: "14px", borderTop: "1px solid var(--divider)" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>{i18n.t("settings.smtp.rulesTitle")}</div>
        <div style={{ fontSize: "12.5px", color: "var(--text-secondary)", lineHeight: 1.85 }}>
          {i18n.t("settings.smtp.rulesBody")}
        </div>
      </div>
    </section>
  );
}
