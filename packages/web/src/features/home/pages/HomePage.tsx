/**
 * Public marketing landing — light theme, prototype v20 fidelity.
 * Stats: static marketing numbers from prototype (1000+ / 94%); no avg-time / language-count.
 * Icons: simple stroke SVGs (no emoji).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { i18n } from "../../../shared/i18n/index.js";

const RED = "#e5342d";

const FEATURES: Array<{ icon: ReactNode; t: string; d: string }> = [
  { icon: <IcChat />, t: "对话式安全审计", d: "安全数字员工形态。上传代码后直接对话：\"帮我审计一下 Git 仓库安全\"，Agent 自动理解意图、规划执行、返回结果。" },
  { icon: <IcSearch />, t: "深度源代码审计", d: "基于 CWE 标准，检测 SQL 注入、命令注入、Stored XSS、反序列化 RCE、任意文件上传等 100+ 漏洞类型。" },
  { icon: <IcZap />, t: "POC/EXP 自动生成", d: "启用 POC/EXP 设置后，Agent 自动为发现的漏洞生成可复现的 POC 与利用代码，加速验证与修复。" },
  { icon: <IcChart />, t: "实时任务仪表板", d: "严重性分布、漏洞 TOP5、审核进度、Token 用量一目了然，支持按用户与项目多维筛选。" },
  { icon: <IcFile />, t: "结构化漏洞报告", d: "报告 skill 根据自定义需求生成符合企业要求的详细报告。" },
  { icon: <IcCpu />, t: "灵活模型接入", d: "支持接入 CloudRouter 平台 Token 或企业自有 API（OpenAI 兼容），Deepseek/Kimi/GPT/Claude 一键切换。" },
];

const CAPS: Array<{ icon: ReactNode; t: string; d: string }> = [
  { icon: <IcGit />, t: "Git 仓库接入", d: "GitHub / GitLab / Gitea 私域仓库直连" },
  { icon: <IcUpload />, t: "压缩包上传", d: "支持 ZIP/TAR 直传，大包秒级解析" },
  { icon: <IcLock />, t: "认证与权限", d: "检测 Missing Auth / Cookie Security / IDOR" },
  { icon: <IcInject />, t: "注入类漏洞", d: "SQL / OS Command / LDAP / Template 注入" },
  { icon: <IcGlobe />, t: "XSS / CSRF", d: "Stored / Reflected / DOM-based XSS 全覆盖" },
  { icon: <IcUpload />, t: "文件上传", d: "Unrestricted Upload / Path Traversal" },
  { icon: <IcCode />, t: "反序列化", d: "Java/PHP/.NET Deserialization RCE 检测" },
  { icon: <IcEye />, t: "敏感信息", d: "硬编码密钥/Token/凭证泄露扫描" },
  { icon: <IcTarget />, t: "业务逻辑漏洞", d: "越权/薅羊毛/竞态条件智能识别" },
  { icon: <IcShare />, t: "供应链安全", d: "依赖项 CVE 匹配与传染路径分析" },
  { icon: <IcShield />, t: "POC/EXP 沙箱", d: "隔离环境验证利用可行性" },
  { icon: <IcList />, t: "合规审计", d: "对齐 OWASP TOP10 / 等保 2.0 / GDPR" },
];

const WHYS: Array<{ icon: ReactNode; t: string; d: string }> = [
  { icon: <IcCpu />, t: "Agent Harness 自研框架", d: "不依赖单模型能力，通过多轮规划-执行-反思循环，把大模型能力放大 10 倍，检出率显著优于传统 SAST。" },
  { icon: <IcChat />, t: "对话即操作", d: "无需学习复杂界面。所有功能都能通过对话完成：\"扫一下这个仓库\"、\"生成漏洞报告\"、\"帮我写 POC\"。" },
  { icon: <IcShare />, t: "灵活模型接入", d: "CloudRouter 一键接入主流模型；企业也可接入自有 API 网关，数据 100% 私有化不出网。" },
  { icon: <IcTarget />, t: "可解释 · 可复现", d: "每个漏洞都附带完整推理链、CWE 编号、影响文件行号、POC 复现步骤，非黑盒结果。" },
  { icon: <IcZap />, t: "企业级性能", d: "支持任务队列/并发/断点续扫，7×24 无人值守运行；扫描进度可视化、失败自动重试、资源按需伸缩。" },
  { icon: <IcLock />, t: "数据零外传", d: "私有化部署方案支持全离线运行，代码/漏洞/凭证均不出企业内网，满足金融/央国企合规要求。" },
];

const STEPS = [
  { n: "1", t: "接入代码", d: "粘贴 Git 地址或直接上传 ZIP。识别 Java/Go/Python/PHP/JS 等主流栈。" },
  { n: "2", t: "配置凭证", d: "选择 CloudRouter 平台或自有 API。首次登录即可开始。" },
  { n: "3", t: "AI 自主审计", d: "Agent 自动规划扫描策略、执行漏洞挖掘、生成 POC、组织报告。" },
  { n: "4", t: "查看报告", d: "仪表板/任务列表实时查看进度。审计完成后一键导出漏洞报告与修复建议。" },
];

export function HomePage() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div data-testid="home-page" style={{ minHeight: "100vh", background: "#f6f7f9", color: "#111827" }}>
      <header style={{
        ...HDR,
        background: scrolled ? "rgba(255,255,255,0.94)" : "#fff",
        boxShadow: scrolled ? "0 1px 0 #e5e7eb, 0 4px 16px rgba(15,23,42,0.04)" : "0 1px 0 #e5e7eb",
        backdropFilter: scrolled ? "blur(10px)" : undefined,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 18 }}>
          <span style={{ width: 28, height: 28, borderRadius: 8, background: RED, display: "grid", placeItems: "center", color: "#fff", fontWeight: 900 }}>V</span>
          VulnHunter
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link to="/login" data-testid="home-login" style={LINK}>{i18n.t("home.login")}</Link>
          <Link to="/login" data-testid="home-trial" style={BTN_PRIMARY}>{i18n.t("home.trial")}</Link>
        </div>
      </header>

      {/* Hero */}
      <section style={{ maxWidth: 1240, margin: "0 auto", padding: "80px 32px 48px", textAlign: "center", position: "relative" }}>
        <div style={{
          position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
          width: 900, height: 420, background: "radial-gradient(ellipse at center, rgba(229,52,45,0.08), transparent 60%)",
          pointerEvents: "none", zIndex: 0,
        }} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={BADGE} data-testid="home-badge">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: RED }} />
            下一代 AI 安全数字员工 · Agent Harness 自研框架
          </div>
          <h1 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 800, letterSpacing: "-0.03em", margin: "0 0 18px", lineHeight: 1.15, color: "#111827" }}>
            让 AI 成为你的{" "}
            <span style={{ color: RED }}>7×24 小时安全审计工程师</span>
          </h1>
          <p style={{ fontSize: 17, color: "#4b5563", maxWidth: 720, margin: "0 auto 28px", lineHeight: 1.65 }}>
            VulnHunter 是基于自研 Agent Harness 框架的 AI 漏洞猎人，通过一个对话窗口即可完成源代码审计、漏洞挖掘、POC/EXP 生成、修复建议全流程。让企业安全能力从「人工排查」跃迁到「数字员工自治」。
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
            <Link to="/login" style={{ ...BTN_PRIMARY, padding: "12px 22px", fontSize: 15, height: 44, boxSizing: "border-box" }}>
              立即免费试用 <span style={{ marginLeft: 4, fontSize: 15, lineHeight: 1 }}>→</span>
            </Link>
            <a href="#features" style={{ ...BTN_OUTLINE, padding: "12px 22px", fontSize: 15, height: 44, boxSizing: "border-box" }}>
              <span style={{ display: "inline-flex", width: 16, height: 16, marginRight: 6, alignItems: "center", justifyContent: "center" }}>
                <IcPlay />
              </span>
              了解核心能力
            </a>
          </div>

          {/* Prototype marketing stats (fish: use prototype numbers; no avg-time / language-count) */}
          <div style={{ display: "flex", gap: 56, justifyContent: "center", marginTop: 52, flexWrap: "wrap" }} data-testid="home-stats">
            <Stat value="1000+" label="已挖掘漏洞" />
            <Stat value="94%" label="高危漏洞识别率" />
          </div>
        </div>
      </section>

      {/* Product screenshot frame */}
      <section style={{ maxWidth: 1120, margin: "8px auto 0", padding: "0 32px" }} data-testid="home-preview">
        <div style={{
          borderRadius: 14, border: "1px solid #e5e7eb", background: "#fff",
          boxShadow: "0 24px 60px rgba(15,23,42,0.08)", overflow: "hidden",
        }}>
          <div style={{ height: 36, background: "#f3f4f6", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 6, padding: "0 12px" }}>
            <Dot c="#ff5f57" /><Dot c="#febc2e" /><Dot c="#28c840" />
            <span style={{ marginLeft: 10, fontSize: 11, color: "#9ca3af" }}>app.vulnhunter.cn · dashboard</span>
          </div>
          <div style={{
            padding: "24px", minHeight: 200,
            background: "linear-gradient(180deg, #fafbfc 0%, #fff 100%)",
            display: "grid", gridTemplateColumns: "200px 1fr", gap: 16,
          }}>
            <div style={{ background: "#0b0d10", borderRadius: 10, padding: 12, color: "rgba(255,255,255,0.7)", fontSize: 11 }}>
              <div style={{ fontWeight: 700, color: "#fff", marginBottom: 12 }}>VulnHunter</div>
              {["对话", "任务", "仪表板", "设置"].map((x) => (
                <div key={x} style={{ padding: "6px 8px", borderRadius: 6, marginBottom: 4, background: x === "仪表板" ? "rgba(255,255,255,0.1)" : "transparent" }}>{x}</div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, alignContent: "start" }}>
              {[
                { n: "128", l: "总扫描" },
                { n: "1,024", l: "发现漏洞" },
                { n: "86%", l: "高危占比" },
              ].map((c) => (
                <div key={c.l} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: "14px 12px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{c.n}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", marginTop: 4 }}>{c.l}</div>
                </div>
              ))}
              <div style={{ gridColumn: "1 / -1", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, minHeight: 80 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: "#6b7280" }}>严重性分布</div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-end", height: 48 }}>
                  {[70, 45, 30, 18].map((h, i) => (
                    <div key={i} style={{ flex: 1, height: h, borderRadius: 4, background: ["#ef4444", "#f59e0b", "#3b82f6", "#94a3b8"][i] }} />
                  ))}
                </div>
              </div>
            </div>
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
            <div key={f.t} style={CARD}>
              <div style={ICON_WRAP}>{f.icon}</div>
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
              <div style={{ ...ICON_WRAP, width: 36, height: 36, marginBottom: 10 }}>{c.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{c.t}</div>
              <div style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.5 }}>{c.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Why dark */}
      <section style={{ background: "#0f1420", color: "#e8ebef", padding: "64px 32px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <div style={{ ...EYEBROW, color: "rgba(255,255,255,0.45)" }}>Why VulnHunter</div>
          <h2 style={{ ...H2, color: "#fff" }}>为什么选择我们</h2>
          <p style={{ ...LEAD, color: "#b9c0cc" }}>不是又一个 SAST 工具，是能理解意图、能规划、能自主执行的 AI 安全数字员工。</p>
          <div style={GRID2}>
            {WHYS.map((w) => (
              <div key={w.t} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: 18, display: "flex", gap: 14 }}>
                <div style={{ ...ICON_WRAP, background: "rgba(255,255,255,0.08)", color: "#fff", flexShrink: 0 }}>{w.icon}</div>
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
              <div style={{ width: 32, height: 32, borderRadius: 8, background: RED, color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 14, marginBottom: 14 }}>{s.n}</div>
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
        <Link to="/login" style={{ ...BTN_PRIMARY, padding: "12px 24px", fontSize: 15, height: 44, boxSizing: "border-box" }}>
          立即免费试用 <span style={{ marginLeft: 4 }}>→</span>
        </Link>
      </section>

      <footer style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "28px 32px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 360 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, marginBottom: 10 }}>
              <span style={{ width: 24, height: 24, borderRadius: 6, background: RED, display: "grid", placeItems: "center", color: "#fff", fontSize: 12, fontWeight: 900 }}>V</span>
              VulnHunter
            </div>
            <p style={{ margin: 0, color: "#6b7280", fontSize: 13, lineHeight: 1.6 }}>
              AI 漏洞猎人 · 让企业安全审计从人工进入自治时代。基于自研 Agent Harness 框架，为企业提供 7×24 小时安全数字员工。
            </p>
          </div>
          <div style={{ fontSize: 13, color: "#4b5563" }}>
            <div style={{ fontWeight: 700, color: "#111827", marginBottom: 10 }}>公司</div>
            <div style={{ padding: "4px 0" }}>关于我们</div>
            <div style={{ padding: "4px 0" }}>联系销售</div>
            <div style={{ padding: "4px 0" }}>意见反馈</div>
          </div>
        </div>
        <div style={{ maxWidth: 1120, margin: "24px auto 0", paddingTop: 20, borderTop: "1px solid #e5e7eb", textAlign: "center", color: "#9ca3af", fontSize: 12.5 }} data-testid="home-footer-icp">
          © {new Date().getFullYear()} VulnHunter · 云起无垠 · vulnhunter.cn · 备案号：［占位］
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{label}</div>
    </div>
  );
}
function Dot({ c }: { c: string }) {
  return <span style={{ width: 10, height: 10, borderRadius: "50%", background: c, display: "inline-block" }} />;
}

/* ---- stroke icons 18px ---- */
function svgProps(props?: { size?: number }) {
  const s = props?.size ?? 18;
  return { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
}
function IcChat() { return <svg {...svgProps()}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>; }
function IcSearch() { return <svg {...svgProps()}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>; }
function IcZap() { return <svg {...svgProps()}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>; }
function IcChart() { return <svg {...svgProps()}><path d="M3 3v18h18" /><path d="M7 14v4" /><path d="M12 10v8" /><path d="M17 6v12" /></svg>; }
function IcFile() { return <svg {...svgProps()}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h6" /></svg>; }
function IcCpu() { return <svg {...svgProps()}><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9z" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></svg>; }
function IcGit() { return <svg {...svgProps()}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><circle cx="6" cy="18" r="2" /><path d="M6 8v8M6 12c0 3 3 6 8 6" /></svg>; }
function IcUpload() { return <svg {...svgProps()}><path d="M12 3v12" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></svg>; }
function IcLock() { return <svg {...svgProps()}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>; }
function IcInject() { return <svg {...svgProps()}><path d="M12 2v6" /><path d="m9 5 3 3 3-3" /><path d="M5 12h14" /><path d="M7 16h10" /><path d="M9 20h6" /></svg>; }
function IcGlobe() { return <svg {...svgProps()}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></svg>; }
function IcCode() { return <svg {...svgProps()}><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /></svg>; }
function IcEye() { return <svg {...svgProps()}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>; }
function IcTarget() { return <svg {...svgProps()}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></svg>; }
function IcShare() { return <svg {...svgProps()}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M8 7.5 10.5 15M16 7.5 13.5 15" /></svg>; }
function IcShield() { return <svg {...svgProps()}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" /></svg>; }
function IcList() { return <svg {...svgProps()}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>; }
function IcPlay() { return <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7L8 5z" /></svg>; }

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
const CARD: CSSProperties = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 18px" };
const ICON_WRAP: CSSProperties = {
  width: 40, height: 40, borderRadius: 10, background: "rgba(229,52,45,0.08)", color: RED,
  display: "grid", placeItems: "center", marginBottom: 12,
};
