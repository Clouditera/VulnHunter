import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

type Props = { open: boolean; onClose: () => void };

export function FeedbackModal({ open, onClose }: Props) {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const [content, setContent] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSatisfaction(null);
    setContent("");
    setEmail("");
    setError("");
    setDone(false);
  }, [open]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [done, onClose]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (satisfaction == null) {
      setError(i18n.t("feedback.err.satisfaction"));
      return;
    }
    const text = content.trim();
    if (!text) {
      setError(i18n.t("feedback.err.content"));
      return;
    }
    setLoading(true);
    try {
      await api.feedback.submit({
        satisfaction,
        content: text.slice(0, 2000),
        contact_email: email.trim() || null,
      });
      setDone(true);
    } catch {
      setError(i18n.t("feedback.err.submit"));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div data-testid="feedback-modal" role="dialog" aria-modal="true" style={OVERLAY} onClick={onClose}>
      <div style={MODAL} onClick={(e) => e.stopPropagation()}>
        {done ? (
          <div style={{ textAlign: "center", padding: "36px 20px" }} data-testid="feedback-success">
            <div style={{ fontSize: 36, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{i18n.t("feedback.thanks")}</div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>{i18n.t("feedback.title")}</h2>
              <button type="button" onClick={onClose} style={X_BTN} aria-label="close">×</button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={LABEL}>{i18n.t("feedback.satisfaction")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} data-testid="feedback-satisfaction">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
                  const on = satisfaction === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      title={n === 1 ? i18n.t("feedback.satLow") : n === 10 ? i18n.t("feedback.satHigh") : String(n)}
                      onClick={() => setSatisfaction(n)}
                      style={{
                        width: 32, height: 32, borderRadius: "50%", border: on ? "none" : "1px solid var(--border)",
                        background: on ? "var(--brand)" : "var(--bg-page)", color: on ? "#fff" : "var(--text-primary)",
                        fontWeight: 700, fontSize: 13, cursor: "pointer",
                      }}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={LABEL}>{i18n.t("feedback.content")}</div>
              <textarea
                data-testid="feedback-content"
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, 2000))}
                placeholder={i18n.t("feedback.contentPh")}
                rows={5}
                style={TEXTAREA}
                required
              />
              <div style={{ fontSize: 11, color: "var(--text-secondary)", textAlign: "right" }}>{content.length}/2000</div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={LABEL}>{i18n.t("feedback.email")}</div>
              <input
                data-testid="feedback-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={i18n.t("feedback.emailPh")}
                style={INPUT}
              />
            </div>

            {error ? (
              <div data-testid="feedback-error" style={{ color: "var(--brand)", fontSize: 12.5, marginBottom: 10 }}>{error}</div>
            ) : null}

            <button data-testid="feedback-submit" type="submit" disabled={loading} style={SUBMIT}>
              {loading ? i18n.t("feedback.submitting") : i18n.t("feedback.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const OVERLAY: CSSProperties = {
  position: "fixed", inset: 0, zIndex: 95, background: "rgba(15,23,42,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
};
const MODAL: CSSProperties = {
  width: "min(440px, 94vw)", background: "var(--bg-card)", borderRadius: 12,
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)", padding: "20px 22px",
};
const LABEL: CSSProperties = { fontSize: 12.5, fontWeight: 600, marginBottom: 8, color: "var(--text-primary)" };
const INPUT: CSSProperties = {
  width: "100%", height: 38, border: "1px solid var(--border)", borderRadius: 8,
  padding: "0 10px", fontSize: 13, background: "var(--bg-page)", color: "var(--text-primary)", outline: "none",
};
const TEXTAREA: CSSProperties = {
  width: "100%", border: "1px solid var(--border)", borderRadius: 8, padding: 10,
  fontSize: 13, background: "var(--bg-page)", color: "var(--text-primary)", outline: "none", resize: "vertical",
  fontFamily: "inherit", lineHeight: 1.5,
};
const SUBMIT: CSSProperties = {
  width: "100%", height: 40, border: "none", borderRadius: 8, background: "var(--brand)",
  color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer",
};
const X_BTN: CSSProperties = {
  border: "none", background: "transparent", fontSize: 22, cursor: "pointer", color: "var(--text-secondary)", lineHeight: 1,
};
