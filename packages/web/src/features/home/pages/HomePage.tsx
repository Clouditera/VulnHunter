/**
 * Public marketing landing (online commercial edition).
 * Unauthenticated visitors land here; CTAs go to /login.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, type HomePublicStats } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

const CAPABILITIES = [
  { title: "AI 自动审计", desc: "大模型深度理解代码语义，自动发现安全缺陷与业务风险。" },
  { title: "动态沙箱验证", desc: "在隔离沙箱中真实编译运行，验证漏洞可利用性。" },
  { title: "组合利用分析", desc: "自动串联多漏洞攻击链，评估真实业务影响。" },
  { title: "全链路报告", desc: "从发现到复现到修复建议，一键生成专业报告。" },
  { title: "对话式任务", desc: "自然语言描述目标即可创建扫描，与表单能力完全对齐。" },
  { title: "企业级管控", desc: "多用户、凭证隔离、邮件注册、审计留痕，开箱即用。" },
];

const VULN_TYPES = [
  "注入类", "越权访问", "敏感信息泄露", "反序列化", "路径穿越", "SSRF",
  "XSS", "CSRF", "配置风险", "加密误用", "业务逻辑", "供应链组件",
];

const REASONS = [
  { t: "真实可验证", d: "静态发现 + 沙箱动态验证，结论可复现、可审计。" },
  { t: "从发现到利用", d: "POC 复现与 EXP 组合利用评估一体化，影响看得见。" },
  { t: "企业落地就绪", d: "注册登录、权限、SMTP、升级迁移路径均已跑通。" },
  { t: "持续演进", d: "引擎与沙箱能力持续升级，版本可平滑升级。" },
];

const STEPS = [
  { n: "1", t: "注册 / 登录", d: "邮箱验证码注册，或管理员创建账号登录。" },
  { n: "2", t: "创建扫描任务", d: "上传源码包或 Git 地址，可选开启动态验证。" },
  { n: "3", t: "AI 审计 + 沙箱验证", d: "自动分析漏洞，必要时在沙箱中真实复现。" },
  { n: "4", t: "查看报告与修复", d: "三卡片结论、EXP 页与可下载报告一次齐备。" },
];

export function HomePage() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [stats, setStats] = useState<HomePublicStats | null>(null);

  useEffect(() => {
    api.home.stats().then((r) => setStats(r.stats)).catch(() => setStats(null));
  }, []);

  const findingsTotal = stats?.findings_total;
  const findingsHigh = stats?.findings_high;
  const tasksDone = stats?.tasks_completed;

  return (
    <div data-testid="home-page" style={{ minHeight: "100vh", background: "#0b0d12", color: "#f3f4f6", overflowX: "hidden" }}>
      {/* Top bar */}
      <header style={HDR}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 18 }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, background: "var(--brand, #ef2b2d)", display: "grid", placeItems: "center", color: "#fff", fontWeight: 900 }}>V</span>
          VulnHunter
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Link to="/login" data-testid="home-login" style={BTN_GHOST}>{i18n.t("home.login")}</Link>
          <Link to="/login" data-testid="home-trial" style={BTN_PRIMARY}>{i18n.t("home.trial")}</Link>
        </div>
      </header>

      {/* Hero */}
      <section style={{ maxWidth: 1240, margin: "0 auto", padding: "72px 32px 48px", textAlign: "center" }}>
        <div style={BADGE}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--brand, #ef2b2d)" }} />
          {i18n.t("home.badge")}
        </div>
        <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 16px", lineHeight: 1.15 }}>
          {i18n.t("home.heroTitle1")}
          <span style={{ color: "var(--brand, #ef2b2d)" }}>{i18n.t("home.heroTitle2")}</span>
        </h1>
        <p style={{ fontSize: 17, color: "#9ca3af", maxWidth: 720, margin: "0 auto 28px", lineHeight: 1.65 }}>
          {i18n.t("home.heroSub")}
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link to="/login" style={{ ...BTN_PRIMARY, padding: "12px 22px", fontSize: 15 }}>{i18n.t("home.ctaStart")}</Link>
          <a href="#capabilities" style={{ ...BTN_GHOST, padding: "12px 22px", fontSize: 15 }}>{i18n.t("home.ctaMore")}</a>
        </div>
        <div style={{ display: "flex", gap: 48, justifyContent: "center", marginTop: 48, flexWrap: "wrap" }}>
          <Stat value={findingsTotal != null ? formatNum(findingsTotal) : "—"} label={i18n.t("home.statFindings")} />
          <Stat value={findingsHigh != null ? formatNum(findingsHigh) : "—"} label={i18n.t("home.statHigh")} />
          <Stat value={tasksDone != null ? formatNum(tasksDone) : "—"} label={i18n.t("home.statTasks")} />
        </div>
      </section>

      {/* Capabilities */}
      <section id="capabilities" style={SECTION}>
        <h2 style={H2}>{i18n.t("home.capTitle")}</h2>
        <p style={SUB}>{i18n.t("home.capSub")}</p>
        <div style={GRID3}>
          {CAPABILITIES.map((c) => (
            <div key={c.title} style={CARD}>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{c.title}</div>
              <div style={{ color: "#9ca3af", fontSize: 13.5, lineHeight: 1.6 }}>{c.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Vuln types */}
      <section style={SECTION}>
        <h2 style={H2}>{i18n.t("home.typesTitle")}</h2>
        <p style={SUB}>{i18n.t("home.typesSub")}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
          {VULN_TYPES.map((t) => (
            <span key={t} style={CHIP}>{t}</span>
          ))}
        </div>
      </section>

      {/* Why us */}
      <section style={SECTION}>
        <h2 style={H2}>{i18n.t("home.whyTitle")}</h2>
        <div style={GRID2}>
          {REASONS.map((r) => (
            <div key={r.t} style={CARD}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{r.t}</div>
              <div style={{ color: "#9ca3af", fontSize: 13.5, lineHeight: 1.6 }}>{r.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section style={SECTION}>
        <h2 style={H2}>{i18n.t("home.stepsTitle")}</h2>
        <div style={GRID4}>
          {STEPS.map((s) => (
            <div key={s.n} style={{ ...CARD, textAlign: "left" }}>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--brand, #ef2b2d)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, marginBottom: 10 }}>{s.n}</div>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{s.t}</div>
              <div style={{ color: "#9ca3af", fontSize: 13, lineHeight: 1.55 }}>{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.08)", padding: "28px 32px", textAlign: "center", color: "#6b7280", fontSize: 12.5 }}>
        <div style={{ marginBottom: 8 }}>© {new Date().getFullYear()} VulnHunter · {i18n.t("home.footerTag")}</div>
        <div data-testid="home-footer-icp">{i18n.t("home.footerIcpPlaceholder")}</div>
      </footer>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k+`;
  if (n >= 1000) return `${n.toLocaleString()}`;
  return String(n);
}

const HDR: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "16px 32px", borderBottom: "1px solid rgba(255,255,255,0.06)",
  position: "sticky", top: 0, backdropFilter: "blur(12px)", background: "rgba(11,13,18,0.85)", zIndex: 20,
};
const BTN_PRIMARY: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: "8px 16px", borderRadius: 8, background: "var(--brand, #ef2b2d)", color: "#fff",
  fontWeight: 700, fontSize: 13.5, textDecoration: "none", border: "none",
};
const BTN_GHOST: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: "8px 16px", borderRadius: 8, background: "transparent", color: "#e5e7eb",
  fontWeight: 600, fontSize: 13.5, textDecoration: "none", border: "1px solid rgba(255,255,255,0.14)",
};
const BADGE: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px",
  background: "rgba(239,43,45,0.12)", color: "var(--brand, #ef2b2d)", borderRadius: 99,
  fontSize: 13, fontWeight: 600, marginBottom: 20,
};
const SECTION: CSSProperties = { maxWidth: 1120, margin: "0 auto", padding: "56px 32px" };
const H2: CSSProperties = { fontSize: 28, fontWeight: 800, textAlign: "center", margin: "0 0 10px" };
const SUB: CSSProperties = { textAlign: "center", color: "#9ca3af", margin: "0 0 28px", fontSize: 15 };
const GRID3: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14 };
const GRID2: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14 };
const GRID4: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 };
const CARD: CSSProperties = {
  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12, padding: "18px 18px",
};
const CHIP: CSSProperties = {
  padding: "8px 14px", borderRadius: 999, background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.1)", fontSize: 13, color: "#d1d5db",
};
