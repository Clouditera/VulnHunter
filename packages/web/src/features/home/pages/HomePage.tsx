/**
 * Marketing homepage — prototype v20 fidelity (designer fix-spec v1.0).
 * Fish rules kept: no avg scan time / no language-count; real stats for findings.
 * Icons: stroke SVGs (no emoji). Feedback NEW removed elsewhere.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type HomePublicStats } from "../../../shared/api/client.js";

const RED = "#e5342d";

type Card = { icon: ReactNode; t: string; d: string };

const FEATURES: Card[] = [
  { icon: <Ic path="M21 11.5a8.38 8.38 0 0 1-8.5 8.5c-1.3 0-2.5-.3-3.6-.7L3 21l1.7-5.9A8.5 8.5 0 1 1 21 11.5z" />, t: "对话式安全审计", d: "安全数字员工形态。上传代码后直接对话：\"帮我审计一下 Git 仓库安全\"，Agent 自动理解意图、规划执行、返回结果。" },
  { icon: <Ic path="M8 6 3 12l5 6M16 6l5 6-5 6" />, t: "深度源代码审计", d: "基于 CWE 标准，检测 SQL 注入、命令注入、Stored XSS、反序列化 RCE、任意文件上传等 100+ 漏洞类型。" },
  { icon: <Ic path="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />, t: "POC/EXP 自动生成", d: "启用 POC/EXP 设置后，Agent 自动为发现的漏洞生成可复现的 POC 与利用代码，加速验证与修复。" },
  { icon: <Ic path="M3 3v18h18M8 17V9m5 8V5m5 12v-6" />, t: "实时任务仪表板", d: "严重性分布、漏洞 TOP5、审核进度、Token 用量一目了然，支持按用户与项目多维筛选。" },
  { icon: <Ic path="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6" />, t: "结构化漏洞报告", d: "报告.skill 根据自定义需求生成符合企业要求的详细报告。" },
  { icon: <Ic path="M9 7V2m6 5V2M7 7h10v4a5 5 0 0 1-10 0zM12 16v6" />, t: "灵活模型接入", d: "支持接入 CloudRouter 平台 Token 或企业自有 API（OpenAI 兼容），Deepseek/Kimi/GPT/Claude 一键切换。" },
];

const CAPS: Card[] = [
  { icon: <Ic path="M6 3v12m0 0a3 3 0 1 0 3 3M6 15a3 3 0 1 1-3 3m12-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 0v3a6 6 0 0 1-6 6" size={16} />, t: "Git 仓库接入", d: "GitHub / GitLab / Gitea 私域仓库直连" },
  { icon: <Ic path="M4 4h16v4H4zM5 8v12h14V8M10 12h4" size={16} />, t: "压缩包上传", d: "支持 ZIP/TAR 直传，2GB 以内秒级解析" },
  { icon: <Ic path="M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5zM12 15v3" size={16} />, t: "认证与权限", d: "检测 Missing Auth / Cookie Security / IDOR" },
  { icon: <Ic path="M4 17l6-5-6-5m6 10h8" size={16} />, t: "注入类漏洞", d: "SQL / OS Command / LDAP / Template 注入" },
  { icon: <Ic path="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2c3 3.5 3 16.5 0 20-3-3.5-3-16.5 0-20z" size={16} />, t: "XSS / CSRF", d: "Stored / Reflected / DOM-based XSS 全覆盖" },
  { icon: <Ic path="M12 16V4m0 0 4 4m-4-4L8 8M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" size={16} />, t: "文件上传", d: "Unrestricted Upload / Path Traversal" },
  { icon: <Ic path="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" size={16} />, t: "反序列化", d: "Java/PHP/.NET Deserialization RCE 检测" },
  { icon: <Ic path="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L19 4m-3.5 3.5L18 10" size={16} />, t: "敏感信息", d: "硬编码密钥/Token/凭证泄露扫描" },
  { icon: <Ic path="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" size={16} />, t: "业务逻辑漏洞", d: "越权/薅羊毛/竞态条件智能识别" },
  { icon: <Ic path="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" size={16} />, t: "供应链安全", d: "依赖项 CVE 匹配与传染路径分析" },
  { icon: <Ic path="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" size={16} />, t: "POC/EXP 沙箱", d: "隔离环境验证利用可行性" },
  { icon: <Ic path="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" size={16} />, t: "合规审计", d: "对齐 OWASP TOP10 / 等保 2.0 / GDPR" },
];

const WHYS: Card[] = [
  { icon: <Ic path="M4 4h16v16H4zM9 9h6v6H9zM9 1v3m6-3v3M9 20v3m6-3v3M1 9h3m-3 6h3M20 9h3m-3 6h3" />, t: "Agent Harness 自研框架", d: "不依赖单模型能力，通过多轮规划-执行-反思循环，把大模型能力放大 10 倍，检出率显著优于传统 SAST。" },
  { icon: <Ic path="M21 11.5a8.38 8.38 0 0 1-8.5 8.5c-1.3 0-2.5-.3-3.6-.7L3 21l1.7-5.9A8.5 8.5 0 1 1 21 11.5z" />, t: "对话即操作", d: "无需学习复杂界面。所有功能都能通过对话完成：\"扫一下这个仓库\"、\"生成漏洞报告\"、\"帮我写 POC\"。" },
  { icon: <Ic path="M9 7V2m6 5V2M7 7h10v4a5 5 0 0 1-10 0zM12 16v6" />, t: "灵活模型接入", d: "CloudRouter 一键接入主流模型；企业也可接入自有 API 网关，数据 100% 私有化不出网。" },
  { icon: <Ic path="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />, t: "可解释 · 可复现", d: "每个漏洞都附带完整推理链、CWE 编号、影响文件行号、POC 复现步骤，非黑盒结果。" },
  { icon: <Ic path="M12 15l3.5-3.5M20.2 13a8.5 8.5 0 1 0-16.4 0" />, t: "企业级性能", d: "支持任务队列/并发/断点续扫，7×24 无人值守运行；扫描进度可视化、失败自动重试、资源按需伸缩。" },
  { icon: <Ic path="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM4 4l16 16" />, t: "数据零外传", d: "私有化部署方案支持全离线运行，代码/漏洞/凭证均不出企业内网，满足金融/央国企合规要求。" },
];

const STEPS = [
  { n: "1", t: "接入代码", d: "粘贴 Git 地址或直接上传 ZIP。支持主流语言与构建体系，识别 Java/Go/Python/PHP/JS 等栈。" },
  { n: "2", t: "配置凭证", d: "选择 CloudRouter 平台或自有 API。首次登录即可开始。" },
  { n: "3", t: "AI 自主审计", d: "Agent 自动规划扫描策略、执行漏洞挖掘、生成 POC、组织报告。你可以关掉页面去开会。" },
  { n: "4", t: "查看报告", d: "仪表板/任务列表实时查看进度。审计完成后一键导出漏洞报告与修复建议。" },
];

export function HomePage() {
  const [scrolled, setScrolled] = useState(false);
  const [stats, setStats] = useState<HomePublicStats | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    api.home.stats().then((r) => setStats(r.stats)).catch(() => setStats(null));
  }, []);

  const showStats = stats != null && (stats.findings_total > 0 || stats.findings_high > 0 || stats.tasks_completed > 0);

  return (
    <div data-testid="home-page" style={{ minHeight: "100vh", background: "#f6f7f9", color: "#111827" }}>
      <header style={{
        ...HDR,
        background: scrolled ? "rgba(255,255,255,0.94)" : "#fff",
        boxShadow: scrolled ? "0 1px 0 #e5e7eb, 0 4px 16px rgba(15,23,42,0.04)" : "0 1px 0 #e5e7eb",
        backdropFilter: scrolled ? "blur(10px)" : undefined,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 18 }}>
          <span style={LOGO}>V</span>
          VulnHunter
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link to="/login" data-testid="home-login" style={NAV_LINK}>登录</Link>
          <Link to="/login" data-testid="home-trial" style={{ ...BTN_PRIMARY, height: 36, padding: "0 16px" }}>免费试用</Link>
        </div>
      </header>

      {/* Hero */}
      <section style={{ maxWidth: 1240, margin: "0 auto", padding: "80px 32px 40px", textAlign: "center", position: "relative" }}>
        <div aria-hidden style={{
          position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
          width: 900, height: 420, background: "radial-gradient(ellipse at center, rgba(229,52,45,0.08), transparent 60%)",
          pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={BADGE} data-testid="home-badge">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: RED }} />
            下一代 AI 安全数字员工 · Agent Harness 自研框架
          </div>
          <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 18px", lineHeight: 1.15 }}>
            让 AI 成为你的{" "}
            <span style={{ color: RED }}>7×24 小时安全审计工程师</span>
          </h1>
          <p style={{ fontSize: 17, color: "#4b5563", maxWidth: 720, margin: "0 auto 28px", lineHeight: 1.65 }}>
            VulnHunter 是基于自研 Agent Harness 框架的 AI 漏洞猎人，通过一个对话窗口即可完成源代码审计、漏洞挖掘、POC/EXP 生成、修复建议全流程。让企业安全能力从「人工排查」跃迁到「数字员工自治」。
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
            <Link to="/login" style={{ ...BTN_PRIMARY, height: 44, padding: "0 22px", fontSize: 15, gap: 6 }}>
              立即免费试用
              <Ic path="M5 12h14m-6-6 6 6-6 6" size={14} />
            </Link>
            <a href="#features" style={{ ...BTN_OUTLINE, height: 44, padding: "0 22px", fontSize: 15, gap: 6 }}>
              <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 4l14 8-14 8z" /></svg>
              观看产品演示
            </a>
          </div>

          {showStats ? (
            <div style={{ display: "flex", gap: 56, justifyContent: "center", marginTop: 52, flexWrap: "wrap" }} data-testid="home-stats">
              <Stat value={fmt(stats!.findings_total)} label="已挖掘漏洞" />
              <Stat value={fmt(stats!.findings_high)} label="高危漏洞" />
              <Stat value={fmt(stats!.tasks_completed)} label="已完成扫描" />
            </div>
          ) : null}
        </div>
      </section>

      {/* Real product screenshot */}
      <section style={{ maxWidth: 1120, margin: "24px auto 0", padding: "0 32px" }} data-testid="home-preview">
        <div style={{
          borderRadius: 14, border: "1px solid #e5e7eb", background: "#fff",
          boxShadow: "0 24px 60px rgba(15,23,42,0.08)", overflow: "hidden",
        }}>
          <div style={{ height: 36, background: "#f3f4f6", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 6, padding: "0 12px" }}>
            <Dot c="#ff5f57" /><Dot c="#febc2e" /><Dot c="#28c840" />
            <span style={{ marginLeft: 10, fontSize: 11, color: "#9ca3af" }}>vulnhunter.cn/dashboard</span>
          </div>
          <img
            src="/home/dashboard-preview.png"
            alt="VulnHunter 产品仪表板截图"
            style={{ display: "block", width: "100%", height: "auto" }}
          />
        </div>
      </section>

      {/* Six features */}
      <section id="features" style={SECTION}>
        <div style={EYEBROW}>Product Features</div>
        <h2 style={H2}>六大核心能力，重新定义安全审计</h2>
        <p style={LEAD}>从 Git 仓库接入到漏洞报告输出，VulnHunter 覆盖企业级安全审计的全链路。</p>
        <div style={GRID3}>
          {FEATURES.map((f) => (
            <div key={f.t} style={CARD}>
              <div style={ICON_LIGHT}>{f.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>{f.t}</div>
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
            <div key={c.t} style={CARD}>
              <div style={{ ...ICON_LIGHT, width: 36, height: 36, marginBottom: 10 }}>{c.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{c.t}</div>
              <div style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.5 }}>{c.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Why */}
      <section style={{ background: "#0f1420", color: "#e8ebef", padding: "64px 32px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <div style={{ ...EYEBROW, color: "rgba(255,255,255,0.45)" }}>Why VulnHunter</div>
          <h2 style={{ ...H2, color: "#fff" }}>为什么选择我们</h2>
          <p style={{ ...LEAD, color: "#b9c0cc" }}>不是又一个 SAST 工具，是能理解意图、能规划、能自主执行的 AI 安全数字员工。</p>
          <div style={GRID2}>
            {WHYS.map((w) => (
              <div key={w.t} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 18, display: "flex", gap: 14 }}>
                <div style={ICON_DARK}>{w.icon}</div>
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
            <div key={s.n} style={CARD}>
              <div style={{ width: 28, height: 28, borderRadius: 6, background: RED, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14, marginBottom: 14 }}>{s.n}</div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{s.t}</div>
              <div style={{ color: "#4b5563", fontSize: 13, lineHeight: 1.6 }}>{s.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ ...SECTION, textAlign: "center", paddingTop: 24 }}>
        <h2 style={{ ...H2, marginBottom: 10 }}>准备好雇佣你的 AI 安全数字员工了吗？</h2>
        <p style={{ ...LEAD, marginBottom: 24 }}>登录 vulnhunter.cn，开启你的第一次 AI 安全审计</p>
        <Link to="/login" style={{ ...BTN_PRIMARY, height: 44, padding: "0 24px", fontSize: 15, gap: 6 }}>
          立即免费试用
          <Ic path="M5 12h14m-6-6 6 6-6 6" size={14} />
        </Link>
      </section>

      <footer style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "28px 32px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 380 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, marginBottom: 10 }}>
              <span style={{ ...LOGO, width: 24, height: 24, fontSize: 12, borderRadius: 6 }}>V</span>
              VulnHunter
            </div>
            <p style={{ margin: 0, color: "#6b7280", fontSize: 13, lineHeight: 1.6 }}>
              AI 漏洞猎人 · 让企业安全审计从人工进入自治时代。基于自研 Agent Harness 框架，为企业提供 7×24 小时安全数字员工。
            </p>
          </div>
          <div style={{ fontSize: 13, color: "#4b5563" }}>
            <div style={{ fontWeight: 700, color: "#111827", marginBottom: 10 }}>公司</div>
            <div style={{ padding: "5px 0" }}>关于我们</div>
            <div style={{ padding: "5px 0" }}>联系销售</div>
            <div style={{ padding: "5px 0" }}>意见反馈</div>
          </div>
        </div>
        <div style={{ maxWidth: 1120, margin: "24px auto 0", paddingTop: 20, borderTop: "1px solid #e5e7eb", textAlign: "center", color: "#9ca3af", fontSize: 12.5 }} data-testid="home-footer-icp">
          © {new Date().getFullYear()} VulnHunter · 云起无垠 · vulnhunter.cn · 备案号：京ICP备2024xxxxxxxx号-1
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{label}</div>
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

function Ic({ path, size = 18 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  );
}

const HDR: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "14px 32px", position: "sticky", top: 0, zIndex: 30,
};
const LOGO: CSSProperties = {
  width: 28, height: 28, borderRadius: 8, background: RED, display: "grid", placeItems: "center", color: "#fff", fontWeight: 900,
};
const NAV_LINK: CSSProperties = { color: "#4b5563", fontWeight: 600, fontSize: 14, textDecoration: "none" };
const BTN_PRIMARY: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  borderRadius: 8, background: RED, color: "#fff", fontWeight: 700, textDecoration: "none", border: "none",
};
const BTN_OUTLINE: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  borderRadius: 8, background: "#fff", color: "#111827", fontWeight: 600, textDecoration: "none", border: "1px solid #e5e7eb",
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
const CARD: CSSProperties = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: 18 };
const ICON_LIGHT: CSSProperties = {
  width: 36, height: 36, borderRadius: 8, background: "#fdeceb", color: RED,
  display: "grid", placeItems: "center", marginBottom: 12,
};
const ICON_DARK: CSSProperties = {
  width: 36, height: 36, borderRadius: 8, background: "rgba(229,52,45,0.15)", color: "#ff6b61",
  display: "grid", placeItems: "center", flexShrink: 0,
};
