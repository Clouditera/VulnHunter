import { useState, useEffect, useCallback, type CSSProperties, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";
import { SupportContactFooterLine } from "../../../shared/components/SupportContact.js";
import { useEdition } from "../../../shared/hooks/useEdition.js";
import { isStrongPassword } from "../../../shared/lib/password.js";

type Panel = "login" | "register" | "forgot";

type ClientErr = Error & { code?: string };

const FIELD: CSSProperties = {
  width: "100%",
  border: "none",
  borderBottom: "1.5px solid var(--border)",
  background: "transparent",
  padding: "10px 0",
  fontSize: "14px",
  color: "var(--text-primary)",
  outline: "none",
  transition: "border-color 0.15s",
};
const LABEL: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--text-primary)",
  marginBottom: "4px",
};
const LINK: CSSProperties = {
  fontSize: "13px",
  color: "var(--text-secondary)",
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
  textDecoration: "none",
};
const PRIMARY_BTN = (loading: boolean): CSSProperties => ({
  width: "100%",
  padding: "13px",
  marginTop: "24px",
  background: loading ? "var(--bg-disabled)" : "var(--brand)",
  color: loading ? "var(--text-secondary)" : "var(--btn-primary-text)",
  border: "none",
  borderRadius: "6px",
  fontSize: "14px",
  fontWeight: 600,
  cursor: loading ? "not-allowed" : "pointer",
});

function errMessage(err: unknown, fallback: string): string {
  const e = err as ClientErr;
  const code = e?.code ?? "";
  const detail = e?.message ?? "";
  // Prefer backend detail for smtp_not_configured and rate limits when present.
  if (code === "smtp_not_configured" || /smtp_not_configured/i.test(code) || /未配置邮件/.test(detail)) {
    return i18n.t("auth.err.smtpNotConfigured");
  }
  // smtp_send_failed: server logs the real reason; users get neutral copy only.
  if (code === "smtp_send_failed") return i18n.t("auth.err.sendFailed");
  if (code === "rate_limited" || code === "ERR_RATE_LIMITED") return i18n.t("auth.err.rateLimited");
  if (code === "invalid_code") return i18n.t("auth.err.invalidCode");
  if (code === "code_expired") return i18n.t("auth.err.codeExpired");
  if (code === "attempts_exceeded") return i18n.t("auth.err.attemptsExceeded");
  if (code === "weak_password") return i18n.t("auth.err.weakPassword");
  if (code === "email_exists" || code === "ERR_EMAIL_EXISTS") return i18n.t("auth.err.emailExists");
  if (code === "agreements_required") return i18n.t("auth.err.agreementsRequired");
  if (code === "account_suspended" || code === "ERR_ACCOUNT_SUSPENDED") return i18n.t("auth.err.suspended");
  if (code === "ERR_AUTH_LOCKED") return i18n.t("login.errorLocked");
  if (code === "invalid_email") return i18n.t("auth.err.invalidEmail");
  if (detail && detail !== code) return detail;
  return fallback;
}

function Field({
  label, value, onChange, type = "text", testid, placeholder, autoComplete, disabled, maxLength, hint,
}: {
  label: string; value: string; onChange: (v: string) => void; type?: string; testid: string;
  placeholder?: string; autoComplete?: string; disabled?: boolean; maxLength?: number; hint?: string;
}) {
  return (
    <div style={{ marginTop: "16px" }}>
      <label style={LABEL}>{label}</label>
      <input
        data-testid={testid}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        disabled={disabled}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        onFocus={(e) => { e.currentTarget.style.borderBottomColor = "var(--brand)"; }}
        onBlur={(e) => { e.currentTarget.style.borderBottomColor = "var(--border)"; }}
        style={{ ...FIELD, opacity: disabled ? 0.5 : 1 }}
      />
      {hint ? <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "4px" }}>{hint}</div> : null}
    </div>
  );
}

function Banner({ kind, children }: { kind: "ok" | "err"; children: string }) {
  const ok = kind === "ok";
  return (
    <div
      data-testid={ok ? "auth-ok-banner" : "auth-err-banner"}
      style={{
        marginTop: "14px",
        padding: "10px 12px",
        borderRadius: "6px",
        fontSize: "12.5px",
        lineHeight: 1.5,
        background: ok ? "rgba(22,163,74,0.08)" : "rgba(185,28,28,0.08)",
        color: ok ? "var(--status-completed, var(--status-completed))" : "var(--brand)",
        border: `1px solid ${ok ? "rgba(22,163,74,0.25)" : "rgba(185,28,28,0.25)"}`,
      }}
    >
      {children}
    </div>
  );
}

export function LoginPage() {
  const [panel, setPanel] = useState<Panel>("login");
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);
  const { isSaas } = useEdition();

  return (
    <AuthSplitLayout
      testid="login-page"
      footer={isSaas ? <SupportContactFooterLine /> : null}
    >
      {panel === "login" && <LoginPanel canRegister={isSaas} onGoRegister={() => setPanel("register")} onGoForgot={() => setPanel("forgot")} />}
      {/* HALL-6: 自助注册仅 SaaS 开放；企业/社区版由管理员建号，不渲染注册面板（也不请求协议目录） */}
      {panel === "register" && isSaas && <RegisterPanel onBack={() => setPanel("login")} />}
      {panel === "forgot" && <ForgotPanel onBack={() => setPanel("login")} />}
    </AuthSplitLayout>
  );
}

function LoginPanel({ canRegister, onGoRegister, onGoForgot }: { canRegister: boolean; onGoRegister: () => void; onGoForgot: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.auth.login(email, password);
      qc.clear();
      if (res.user?.mustChangePassword) navigate("/change-password");
      else if (import.meta.env.VITE_APP_DOMAIN === "admin") {
        navigate(res.user?.role === "admin" ? "/admin" : "/");
      } else {
        navigate("/chat");
      }
    } catch (err) {
      setError(errMessage(err, i18n.t("login.errorInvalid")));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div data-testid="auth-panel-login">
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 6px", letterSpacing: "-0.01em" }}>
        {i18n.t("login.title")}
      </h1>
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 20px", lineHeight: 1.6 }}>
        {i18n.t("login.subtitle")}
      </p>
      <form onSubmit={handleLogin}>
        <Field label={i18n.t("login.email")} value={email} onChange={setEmail} type="email" testid="login-email" placeholder="you@company.com" autoComplete="username" />
        <Field label={i18n.t("login.password")} value={password} onChange={setPassword} type="password" testid="login-password" placeholder="••••••••" autoComplete="current-password" />
        {error ? <Banner kind="err">{error}</Banner> : null}
        <button data-testid="login-submit" type="submit" disabled={loading} style={PRIMARY_BTN(loading)}>
          {loading ? i18n.t("login.signing") : i18n.t("login.submit")}
        </button>
      </form>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "18px" }}>
        <button type="button" data-testid="auth-go-forgot" onClick={onGoForgot} style={LINK}>
          {i18n.t("auth.forgotLink")}
        </button>
        {canRegister ? (
          <button type="button" data-testid="auth-go-register" onClick={onGoRegister} style={{ ...LINK, color: "var(--brand)", fontWeight: 600 }}>
            {i18n.t("auth.registerLink")}
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

function useDataDown() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);
  const start = useCallback((n: number) => setSeconds(Math.max(0, Math.floor(n))), []);
  return { seconds, start, active: seconds > 0 };
}

type AgreementMeta = {
  id: string;
  title: string;
  version: string;
  effective_date: string;
  required_on_register: boolean;
  html_url: string;
};

function AgreementModal({
  title,
  html,
  onClose,
}: {
  title: string;
  html: string;
  onClose: () => void;
}) {
  // ESC closes (fish 2026-08-07 unified modal base); backdrop never does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Extract body inner HTML so we don't nest full documents.
  const bodyHtml = (() => {
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return m ? m[1] : html;
  })();
  return (
    <div
      data-testid="agreement-modal"
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      <div
        style={{
          width: "min(720px, 100%)",
          maxHeight: "min(80vh, 840px)",
          background: "var(--bg-card)",
          borderRadius: "12px",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--divider)",
          }}
        >
          <div style={{ fontSize: "15px", fontWeight: 700 }}>{title}</div>
          <button
            type="button"
            data-testid="agreement-modal-close"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              fontSize: "20px",
              cursor: "pointer",
              color: "var(--text-secondary)",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div
          data-testid="agreement-modal-body"
          style={{
            padding: "18px 22px",
            overflow: "auto",
            fontSize: "13.5px",
            lineHeight: 1.7,
            color: "var(--text-primary)",
          }}
          // Content is first-party legal HTML shipped with the product.
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      </div>
    </div>
  );
}

function RegisterPanel({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [agreements, setAgreements] = useState<AgreementMeta[]>([]);
  const [viewing, setViewing] = useState<{ title: string; html: string } | null>(null);
  const cd = useDataDown();
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    api.auth
      .listAgreements()
      .then((res) => {
        if (!cancelled) setAgreements(res.agreements ?? []);
      })
      .catch(() => {
        // Fallback labels if catalog endpoint not yet upgraded (three private-deploy + SaaS docs).
        if (!cancelled) {
          setAgreements([
            {
              id: "user-service",
              title: "VulHunter 平台用户服务协议",
              version: "1.0",
              effective_date: "2026-07-21",
              required_on_register: true,
              html_url: "/api/auth/agreements/user-service",
            },
            {
              id: "privacy-policy",
              title: "VulHunter 平台隐私政策",
              version: "1.0",
              effective_date: "2026-07-21",
              required_on_register: true,
              html_url: "/api/auth/agreements/privacy-policy",
            },
            {
              id: "saas-service",
              title: "VulHunter SaaS 平台服务协议及软件许可条款",
              version: "1.0",
              effective_date: "2026-07-21",
              required_on_register: true,
              html_url: "/api/auth/agreements/saas-service",
            },
          ]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openAgreement(id: string, title: string) {
    try {
      const res = await api.auth.getAgreement(id);
      setViewing({ title: res.title || title, html: res.html });
    } catch {
      // Fallback: open raw HTML endpoint in a new tab
      window.open(`/api/auth/agreements/${encodeURIComponent(id)}`, "_blank", "noopener,noreferrer");
    }
  }

  async function sendCode() {
    setError("");
    setOkMsg("");
    if (!email.trim()) {
      setError(i18n.t("auth.err.invalidEmail"));
      return;
    }
    setSending(true);
    try {
      const res = await api.auth.registerRequestCode(email.trim());
      cd.start(res.cooldown_seconds ?? 60);
      setOkMsg(i18n.t("auth.codeSent").replace("{email}", email.trim()));
    } catch (err) {
      setError(errMessage(err, i18n.t("auth.err.sendFailed")));
    } finally {
      setSending(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!accepted) {
      setError(i18n.t("auth.err.agreementsRequired"));
      return;
    }
    if (password !== confirm) {
      setError(i18n.t("auth.err.passwordMismatch"));
      return;
    }
    if (!isStrongPassword(password)) {
      setError(i18n.t("auth.err.weakPassword"));
      return;
    }
    setLoading(true);
    try {
      await api.auth.registerVerify({
        email: email.trim(),
        code: code.trim(),
        password,
        accept_agreements: true,
      });
      qc.clear();
      navigate("/chat");
    } catch (err) {
      setError(errMessage(err, i18n.t("auth.err.registerFailed")));
    } finally {
      setLoading(false);
    }
  }

  const requiredAgreements = agreements.filter((a) => a.required_on_register !== false);

  return (
    <div data-testid="auth-panel-register">
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 6px" }}>{i18n.t("auth.registerTitle")}</h1>
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 12px", lineHeight: 1.6 }}>
        {i18n.t("auth.registerSubtitle")}
      </p>
      <form onSubmit={handleRegister}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Field label={i18n.t("login.email")} value={email} onChange={setEmail} type="email" testid="register-email" placeholder="you@company.com" autoComplete="username" />
          </div>
          <button
            type="button"
            data-testid="register-send-code"
            disabled={sending || cd.active}
            onClick={sendCode}
            style={{
              flexShrink: 0,
              height: "38px",
              padding: "0 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: cd.active || sending ? "var(--bg-disabled)" : "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: cd.active || sending ? "not-allowed" : "pointer",
              marginBottom: "1px",
            }}
          >
            {cd.active ? i18n.t("auth.resendIn").replace("{s}", String(cd.seconds)) : i18n.t("auth.sendCode")}
          </button>
        </div>
        {okMsg ? <Banner kind="ok">{okMsg}</Banner> : null}
        {error ? <Banner kind="err">{error}</Banner> : null}
        <Field label={i18n.t("auth.code")} value={code} onChange={setCode} testid="register-code" placeholder={i18n.t("auth.codePlaceholder")} maxLength={6} hint={i18n.t("auth.codeHint")} />
        <Field label={i18n.t("auth.setPassword")} value={password} onChange={setPassword} type="password" testid="register-password" placeholder={i18n.t("auth.passwordPlaceholder")} autoComplete="new-password" hint={i18n.t("auth.passwordHint")} />
        <Field label={i18n.t("auth.confirmPassword")} value={confirm} onChange={setConfirm} type="password" testid="register-confirm" placeholder={i18n.t("auth.confirmPlaceholder")} autoComplete="new-password" />

        <label
          data-testid="register-agreements"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "8px",
            marginTop: "18px",
            fontSize: "12.5px",
            color: "var(--text-secondary)",
            lineHeight: 1.55,
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            data-testid="register-agreements-check"
            style={{ marginTop: "3px" }}
          />
          <span>
            {i18n.t("auth.agreePrefix")}
            {requiredAgreements.map((a, idx) => (
              <span key={a.id}>
                {idx > 0 ? (
                  <span>{idx === requiredAgreements.length - 1 ? i18n.t("auth.agreeAnd") : i18n.t("auth.agreeComma")}</span>
                ) : null}
                <button
                  type="button"
                  data-testid={`open-agreement-${a.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void openAgreement(a.id, a.title);
                  }}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    /* Regular link color — not brand red (fish 2026-07-22) */
                    color: "var(--link, var(--brand))",
                    fontWeight: 500,
                    textDecoration: "underline",
                    textUnderlineOffset: "2px",
                    cursor: "pointer",
                    fontSize: "inherit",
                  }}
                >
                  《{a.title}》
                </button>
              </span>
            ))}
          </span>
        </label>

        <button
          data-testid="register-submit"
          type="submit"
          disabled={loading || !accepted}
          style={{
            ...PRIMARY_BTN(loading || !accepted),
            opacity: !accepted ? 0.55 : 1,
          }}
          title={!accepted ? i18n.t("auth.err.agreementsRequired") : undefined}
        >
          {loading ? i18n.t("auth.registering") : i18n.t("auth.registerSubmit")}
        </button>
      </form>
      <div style={{ marginTop: "18px" }}>
        <button type="button" data-testid="auth-back-login" onClick={onBack} style={LINK}>
          {i18n.t("auth.backToLogin")}
        </button>
      </div>
      {viewing ? (
        <AgreementModal title={viewing.title} html={viewing.html} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}

function ForgotPanel({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [done, setDone] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const cd = useDataDown();

  async function sendCode() {
    setError("");
    setOkMsg("");
    if (!email.trim()) {
      setError(i18n.t("auth.err.invalidEmail"));
      return;
    }
    setSending(true);
    try {
      await api.auth.passwordForgot(email.trim());
      // Always ok — do not reveal existence
      cd.start(60);
      setOkMsg(i18n.t("auth.codeSentGeneric"));
    } catch (err) {
      setError(errMessage(err, i18n.t("auth.err.sendFailed")));
    } finally {
      setSending(false);
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError(i18n.t("auth.err.passwordMismatch"));
      return;
    }
    if (!isStrongPassword(password)) {
      setError(i18n.t("auth.err.weakPassword"));
      return;
    }
    setLoading(true);
    try {
      await api.auth.passwordReset({ email: email.trim(), code: code.trim(), new_password: password });
      setDone(true);
      setOkMsg(i18n.t("auth.resetDone"));
      // Auto return to login after short notice (VULNHUN-161).
      window.setTimeout(() => onBack(), 1200);
    } catch (err) {
      setError(errMessage(err, i18n.t("auth.err.resetFailed")));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div data-testid="auth-panel-forgot">
      <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 6px" }}>{i18n.t("auth.forgotTitle")}</h1>
      <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 12px", lineHeight: 1.6 }}>
        {i18n.t("auth.forgotSubtitle")}
      </p>
      <form onSubmit={handleReset}>
        <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <Field label={i18n.t("login.email")} value={email} onChange={setEmail} type="email" testid="forgot-email" placeholder="you@company.com" autoComplete="username" />
          </div>
          <button
            type="button"
            data-testid="forgot-send-code"
            disabled={sending || cd.active || done}
            onClick={sendCode}
            style={{
              flexShrink: 0,
              height: "38px",
              padding: "0 12px",
              borderRadius: "6px",
              border: "1px solid var(--border)",
              background: cd.active || sending || done ? "var(--bg-disabled)" : "var(--bg-card)",
              color: "var(--text-primary)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: cd.active || sending || done ? "not-allowed" : "pointer",
              marginBottom: "1px",
            }}
          >
            {cd.active ? i18n.t("auth.resendIn").replace("{s}", String(cd.seconds)) : i18n.t("auth.sendCode")}
          </button>
        </div>
        {okMsg ? <Banner kind="ok">{okMsg}</Banner> : null}
        {error ? <Banner kind="err">{error}</Banner> : null}
        <Field label={i18n.t("auth.code")} value={code} onChange={setCode} testid="forgot-code" placeholder={i18n.t("auth.codePlaceholder")} maxLength={6} hint={i18n.t("auth.codeHint")} disabled={done} />
        <Field label={i18n.t("auth.newPassword")} value={password} onChange={setPassword} type="password" testid="forgot-password" placeholder={i18n.t("auth.passwordPlaceholder")} autoComplete="new-password" hint={i18n.t("auth.passwordHint")} disabled={done} />
        <Field label={i18n.t("auth.confirmNewPassword")} value={confirm} onChange={setConfirm} type="password" testid="forgot-confirm" placeholder={i18n.t("auth.confirmPlaceholder")} autoComplete="new-password" disabled={done} />
        {!done ? (
          <button data-testid="forgot-submit" type="submit" disabled={loading} style={PRIMARY_BTN(loading)}>
            {loading ? i18n.t("auth.resetting") : i18n.t("auth.resetSubmit")}
          </button>
        ) : null}
      </form>
      <div style={{ marginTop: "18px" }}>
        <button type="button" data-testid="auth-back-login" onClick={onBack} style={LINK}>
          {i18n.t("auth.backToLogin")}
        </button>
      </div>
    </div>
  );
}
