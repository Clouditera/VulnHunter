/**
 * Public marketing landing — light theme per fish prototype v20.
 * Unauthenticated visitors land on `/`; CTAs go to `/login`.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { api, type HomePublicStats } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";

const RED = "#e5342d";

const FEATURES = [
  { ic: "💬", t: "对话式安全审计", d: "安全数字员工形态。上传代码后直接对话：\"帮我审计一下 Git 仓库安全\"，Agent 自动理解意图、规划执行、返回结果。" },
  { ic: "🔍", t: "深度源代码审计", d: "基于 CWE 标准，检测 SQL 注入、命令注入、Stored XSS、反序列化 RCE、任意文件上传等 100+ 漏洞类型。" },
  { ic: "⚡", t: "POC/EXP 自动生成", d: "启用 POC/EXP 设置后，Agent 自动为发现的漏洞生成可复现的 POC 与利用代码，加速验证与修复。" },
  { ic: "📊", t: "实时任务仪表板", d: "严重性分布、漏洞 TOP5、审核进度、Token 用量一目了然，支持按用户与项目多维筛选。" },
  { ic: "📝", t: "结构化漏洞报告", d: "报告 skill 根据自定义需求生成符合企业要求的详细报告。" },
  { ic: "🧠", t: "灵活模型接入", d: "支持接入 CloudRouter 平台 Token 或企业自有 API（OpenAI 兼容），Deepseek/Kimi/GPT/Claude 一键切换。" },
];

const CAPS = [
  { ic: "📦", t: "Git 仓库接入", d: "GitHub / GitLab / Gitea 私域仓库直连" },
  { ic: "🗜️", t: "压缩包上传", d: "支持 ZIP/TAR 直传，大包秒级解析" },
  { ic: "🔐", t: "认证与权限", d: "检测 Missing Auth / Cookie Security / IDOR" },
  { ic: "💉", t: "注入类漏洞", d: "SQL / OS Command / LDAP / Template 注入" },
  { ic: "🕸️", t: "XSS / CSRF", d: "Stored / Reflected / DOM-based XSS 全覆盖" },
  { ic: "📤", t: "文件上传", d: "Unrestricted Upload / Path Traversal" },
  { ic: "🔓", t: "反序列化", d: "Java/PHP/.NET Deserialization RCE 检测" },
  { ic: "🕵️", t: "敏感信息", d: "硬编码密钥/Token/凭证泄露扫描" },
  { ic: "🎯", t: "业务逻辑漏洞", d: "越权/薅羊毛/竞态条件智能识别" },
  { ic: "🧬", t: "供应链安全", d: "依赖项 CVE 匹配与传染路径分析" },
  { ic: "🛡️", t: "POC/EXP 沙箱", d: "隔离环境验证利用可行性" },
  { ic: "📋", t: "合规审计", d: "对齐 OWASP TOP10 / 等保 2.0 / GDPR" },
];

const WHYS = [
  { ic: "🤖", t: "Agent Harness 自研框架", d: "不依赖单模型能力，通过多轮规划-执行-反思循环，把大模型能力放大，检出率显著优于传统 SAST。" },
  { ic: "💬", t: "对话即操作", d: "无需学习复杂界面。所有功能都能通过对话完成：\"扫一下这个仓库\"、\"生成漏洞报告\"、\"帮我写 POC\"。" },
  { ic: "🔗", t: "灵活模型接入", d: "CloudRouter 一键接入主流模型；企业也可接入自有 API 网关，数据可私有化不出网。" },
  { ic: "🎯", t: "可解释 · 可复现", d: "每个漏洞都附带完整推理链、CWE 编号、影响文件行号、POC 复现步骤，非黑盒结果。" },
  { ic: "⚡", t: "企业级性能", d: "支持任务队列/并发/断点续扫，7×24 无人值守运行；扫描进度可视化、失败自动重试。" },
  { ic: "🔒", t: "数据零外传", d: "私有化部署方案支持全离线运行，代码/漏洞/凭证均不出企业内网，满足金融/央国企合规要求。" },
];

const STEPS = [
  { n: "1", t: "接入代码", d: "粘贴 Git 地址或直接上传 ZIP。支持主流语言与构建体系。" },
  { n: "2", t: "配置凭证", d: "选择 CloudRouter 平台或自有 API，配置后即可开始。" },
  { n: "3", t: "AI 自主审计", d: "Agent 自动规划扫描策略、执行漏洞挖掘、生成 POC、组织报告。" },
  { n: "4", t: "查看报告", d: "仪表板/任务列表实时查看进度，完成后一键导出漏洞报告与修复建议。" },
];

export function HomePage() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [stats, setStats] = useState<HomePublicStats | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    api.home.stats().then((r) => setStats(r.stats)).catch(() => setStats(null));
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const showStats =
    stats != null &&
    (stats.findings_total > 0 || stats.findings_high > 0 || stats.tasks_completed > 0);

  return (
    <div data-testid="home-page" style={{ minHeight: "100vh", background: "#f6f7f9", color: "#111827" }}>
      <header
        style={{
          ...HDR,
          background: scrolled ? "rgba(255,255,255,0.92)" : "#fff",
          boxShadow: scrolled ? "0 1px 0 #e5e7eb, 0 4px 16px rgba(15,23,42,0.04)" : "0 1px 0 #e5e7eb",
          backdropFilter: scrolled ? "blur(10px)" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 18 }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, background: RED, display: "grid", placeItems: "center", color: "#fff", fontWeight: 900 }}>V</span>
          VulnHunter
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Link to="/login" data-testid="home-login" style={LINK}>{i18n.t("home.login")}</Link>
          <Link to="/login" data-testid="home-trial" style={BTN_PRIMARY}>{i18n.t("home.trial")}</Link>
        </div>
      </header>

      {/* Hero */}
      <section style={{ maxWidth: 1240, margin: "0 auto", padding: "80px 32px 40px", textAlign: "center", position: "relative" }}>
        <div style={{
          position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
          width: 900, height: 420, background: "radial-gradient(ellipse at center, rgba(229,52,45,0.08), transparent 60%)",
          pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={BADGE}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: RED }} />
            {i18n.t("home.badge")}
          </div>
          <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 18px", lineHeight: 1.15, color: "#111827" }}>
            {i18n.t("home.heroTitle1")}
            <span style={{ color: RED }}>{i18n.t("home.heroTitle2")}</span>
          </h1>
          <p style={{ fontSize: 17, color: "#4b5563", maxWidth: 720, margin: "0 auto 28px", lineHeight: 1.65 }}>
            {i18n.t("home.heroSub")}
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link to="/login" style={{ ...BTN_PRIMARY, padding: "12px 22px", fontSize: 15 }}>{i18n.t("home.ctaStart")}</Link>
            <a href="#features" style={{ ...BTN_OUTLINE, padding: "12px 22px", fontSize: 15 }}>{i18n.t("home.ctaMore")}</a>
          </div>

          {showStats ? (
            <div style={{ display: "flex", gap: 56, justifyContent: "center", marginTop: 52, flexWrap: "wrap" }} data-testid="home-stats">
              <Stat value={fmt(stats!.findings_total)} label={i18n.t("home.statFindings")} />
              <Stat value={fmt(stats!.findings_high)} label={i18n.t("home.statHigh")} />
              <Stat value={fmt(stats!.tasks_completed)} label={i18n.t("home.statTasks")} />
            </div>
          ) : null}
        </div>
      </section>

      {/* Product preview frame */}
      <section style={{ maxWidth: 1120, margin: "24px auto 0", padding: "0 32px" }} data-testid="home-preview">
        <div style={{
          borderRadius: 14, border: "1px solid #e5e7eb", background: "#fff",
          boxShadow: "0 20px 50px rgba(15,23,42,0.08)", overflow: "hidden",
        }}>
          <div style={{ height: 36, background: "#f3f4f6", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 6, padding: "0 12px" }}>
            <Dot c="#ff5f57" /><Dot c="#febc2e" /><Dot c="#28c840" />
            <span style={{ marginLeft: 10, fontSize: 11, color: "#9ca3af" }}>vulnhunter.cn / dashboard</span>
          </div>
          <div style={{
            padding: "28px 24px", minHeight: 180,
            background: "linear-gradient(180deg, #fafbfc 0%, #fff 100%)",
            display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12,
          }}>
            {[
              { n: showStats ? fmt(stats!.tasks_completed) : "—", l: i18n.t("home.statTasks") },
              { n: showStats ? fmt(stats!.findings_total) : "—", l: i18n.t("home.statFindings") },
              { n: showStats ? fmt(stats!.findings_high) : "—", l: i18n.t("home.statHigh") },
              { n: "AI", l: "Agent Harness" },
            ].map((c) => (
              <div key={c.l} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 12px" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>{c.n}</div>
                <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{c.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Six features */}
      <section id="features" style={SECTION}>
        <div style={EYEBROW}>Product Features</div>
        <h2 style={H2}>六大核心能力，重新定义安全审计</h2>
        <p style={LEAD}>从 Git 仓库接入到漏洞报告输出，VulnHunter 覆盖企业级安全审计的全链路。</p>
        <div style={GRID3}>
          {FEATURES.map((f) => (
            <div key={f.t} style={CARD_LIGHT}>
              <div style={{ fontSize: 22, marginBottom: 10 }}>{f.ic}</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8, color: "#111827" }}>{f.t}</div>
              <div style={{ color: "#4b5563", fontSize: 14, lineHeight: 1.6 }}>{f.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 12 caps */}
      <section id="caps" style={SECTION}>
        <div style={EYEBROW}>Core Capabilities</div>
        <h2 style={H2}>12 类漏洞能力 · 覆盖代码安全全生命周期</h2>
        <p style={LEAD}>从代码接入、漏洞检测、验证复现到合规审计，一个 AI 数字员工在一次对话中完成。</p>
        <div style={GRID4}>
          {CAPS.map((c) => (
            <div key={c.t} style={CARD_LIGHT}>
              <div style={{ fontSize: 20, marginBottom: 8 }}>{c.ic}</div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, color: "#111827" }}>{c.t}</div>
              <div style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.5 }}>{c.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Why — dark band */}
      <section style={{ background: "#0f1420", color: "#e8ebef", padding: "64px 32px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <div style={{ ...EYEBROW, color: "rgba(255,255,255,0.45)" }}>Why VulnHunter</div>
          <h2 style={{ ...H2, color: "#fff" }}>为什么选择我们</h2>
          <p style={{ ...LEAD, color: "#b9c0cc" }}>不是又一个 SAST 工具，是能理解意图、能规划、能自主执行的 AI 安全数字员工。</p>
          <div style={GRID2}>
            {WHYS.map((w) => (
              <div key={w.t} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 18, display: "flex", gap: 14 }}>
                <div style={{ fontSize: 22 }}>{w.ic}</div>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{w.t}</div>
                  <div style={{ color: "#b9c0cc", fontSize: 13.5, lineHeight: 1.6 }}>{w.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 4 steps */}
      <section id="flow" style={SECTION}>
        <div style={EYEBROW}>How It Works</div>
        <h2 style={H2}>4 步启动你的第一次安全审计</h2>
        <p style={LEAD}>从注册到看见第一份漏洞报告，快速上手。</p>
        <div style={GRID4}>
          {STEPS.map((s) => (
            <div key={s.n} style={CARD_LIGHT}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: RED, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14, marginBottom: 14 }}>{s.n}</div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6, color: "#111827" }}>{s.t}</div>
              <div style={{ color: "#4b5563", fontSize: 13, lineHeight: 1.6 }}>{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ ...SECTION, textAlign: "center", paddingTop: 24 }}>
        <h2 style={{ ...H2, marginBottom: 10 }}>准备好雇佣你的 AI 安全数字员工了吗？</h2>
        <p style={{ ...LEAD, marginBottom: 24 }}>登录 VulnHunter，开启你的第一次 AI 安全审计</p>
        <Link to="/login" style={{ ...BTN_PRIMARY, padding: "12px 24px", fontSize: 15 }}>{i18n.t("home.ctaStart")}</Link>
      </section>

      <footer style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "28px 32px", textAlign: "center", color: "#6b7280", fontSize: 12.5 }}>
        <div style={{ marginBottom: 8 }}>© {new Date().getFullYear()} VulnHunter · 云起无垠 · vulnhunter.cn</div>
        <div data-testid="home-footer-icp">{i18n.t("home.footerIcpPlaceholder")}</div>
      </footer>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em", color: "#111827" }}>{value}</div>
      <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span style={{ width: 10, height: 10, borderRadius: "50%", background: c, display: "inline-block" }} />;
}

function fmt(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k+`;
  return n.toLocaleString();
}

const HDR: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "14px 32px", position: "sticky", top: 0, zIndex: 30,
};
const LINK: CSSProperties = { color: "#4b5563", fontWeight: 600, fontSize: 14, textDecoration: "none" };
const BTN_PRIMARY: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: "8px 16px", borderRadius: 8, background: RED, color: "#fff",
  fontWeight: 700, fontSize: 13.5, textDecoration: "none", border: "none",
};
const BTN_OUTLINE: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  padding: "8px 16px", borderRadius: 8, background: "#fff", color: "#111827",
  fontWeight: 600, fontSize: 13.5, textDecoration: "none", border: "1px solid #e5e7eb",
};
const BADGE: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 14px",
  background: "rgba(229,52,45,0.08)", color: RED, borderRadius: 99,
  fontSize: 13, fontWeight: 600, marginBottom: 22,
};
const SECTION: CSSProperties = { maxWidth: 1120, margin: "0 auto", padding: "64px 32px" };
const EYEBROW: CSSProperties = { textAlign: "center", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9ca3af", marginBottom: 10 };
const H2: CSSProperties = { fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 800, textAlign: "center", margin: "0 0 12px", letterSpacing: "-0.02em", color: "#111827" };
const LEAD: CSSProperties = { textAlign: "center", color: "#4b5563", margin: "0 auto 36px", fontSize: 16, maxWidth: 640, lineHeight: 1.6 };
const GRID3: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 };
const GRID2: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 14 };
const GRID4: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12 };
const CARD_LIGHT: CSSProperties = {
  background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 18px",
};
