import { useState, useEffect, useCallback, type CSSProperties, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { AuthSplitLayout } from "../../../shared/components/AuthSplitLayout.js";
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
  if (code === "rate_limited" || code === "ERR_RATE_LIMITED") return i18n.t("auth.err.rateLimited");
  if (code === "invalid_code") return i18n.t("auth.err.invalidCode");
  if (code === "code_expired") return i18n.t("auth.err.codeExpired");
  if (code === "attempts_exceeded") return i18n.t("auth.err.attemptsExceeded");
  if (code === "weak_password") return i18n.t("auth.err.weakPassword");
  if (code === "email_exists" || code === "ERR_EMAIL_EXISTS") return i18n.t("auth.err.emailExists");
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
        color: ok ? "var(--status-completed, #16a34a)" : "var(--brand)",
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

  return (
    <AuthSplitLayout testid="login-page">
      {panel === "login" && <LoginPanel onGoRegister={() => setPanel("register")} onGoForgot={() => setPanel("forgot")} />}
      {panel === "register" && <RegisterPanel onBack={() => setPanel("login")} />}
      {panel === "forgot" && <ForgotPanel onBack={() => setPanel("login")} />}
    </AuthSplitLayout>
  );
}

function LoginPanel({ onGoRegister, onGoForgot }: { onGoRegister: () => void; onGoForgot: () => void }) {
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
      else navigate("/dashboard");
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
        <button type="button" data-testid="auth-go-register" onClick={onGoRegister} style={{ ...LINK, color: "var(--brand)", fontWeight: 600 }}>
          {i18n.t("auth.registerLink")}
        </button>
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

function RegisterPanel({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const cd = useDataDown();
  const navigate = useNavigate();
  const qc = useQueryClient();

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
      await api.auth.registerVerify({ email: email.trim(), code: code.trim(), password });
      qc.clear();
      navigate("/dashboard");
    } catch (err) {
      setError(errMessage(err, i18n.t("auth.err.registerFailed")));
    } finally {
      setLoading(false);
    }
  }

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
        <button data-testid="register-submit" type="submit" disabled={loading} style={PRIMARY_BTN(loading)}>
          {loading ? i18n.t("auth.registering") : i18n.t("auth.registerSubmit")}
        </button>
      </form>
      <div style={{ marginTop: "18px" }}>
        <button type="button" data-testid="auth-back-login" onClick={onBack} style={LINK}>
          {i18n.t("auth.backToLogin")}
        </button>
      </div>
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
