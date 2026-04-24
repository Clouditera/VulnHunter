/**
 * POC/EXP Settings section — DeVeye Server configuration + test connection.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { api } from "../../../shared/api/client.js";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";

export function PocSettingsSection() {
  const [, force] = useState(0);
  useEffect(() => i18n.onChange(() => force((n) => n + 1)), []);

  const { data } = useQuery({
    queryKey: ["poc-settings"],
    queryFn: () => api.settings.getPocSettings(),
  });

  const settings = data?.settings;

  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [timeout, setTimeout_] = useState("1800");
  const [concurrency, setConcurrency] = useState("1");
  const [showToken, setShowToken] = useState(false);
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; server_version?: string; error?: string } | null>(null);

  // Sync from server data
  useEffect(() => {
    if (settings) {
      setServerUrl(settings.deveye_server_url ?? "");
      setToken(settings.deveye_token ?? "");
      setTimeout_(String(settings.poc_timeout_s ?? 1800));
      setConcurrency(String(settings.default_concurrency ?? 1));
    }
  }, [settings]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.settings.updatePocSettings({
        deveye_server_url: serverUrl || undefined,
        deveye_token: token || undefined,
        poc_timeout_s: Number(timeout) || 1800,
        default_concurrency: Number(concurrency) || 1,
      }),
  });

  const testMut = useMutation({
    mutationFn: () =>
      api.settings.testPocConnection({
        server_url: serverUrl || undefined,
        token: token || undefined,
      }),
    onSuccess: (result) => setTestResult(result),
    onError: () => setTestResult({ ok: false, error: "Request failed" }),
  });

  return (
    <section style={CARD} data-testid="settings-card-poc">
      {/* Header */}
      <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--divider)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={ICON_TILE}>
            <Icon name="shield" size={18} />
          </div>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 600 }}>POC/EXP 设置</div>
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
              配置 DeVeye 服务端地址，用于漏洞复现时的浏览器自动化
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Help banner */}
        <div style={HELP_BANNER}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Icon name="alert-triangle" size={14} style={{ color: "#2563eb", flexShrink: 0 }} />
            <span style={{ fontSize: "13px", color: "#1e40af" }}>
              DeVeye 是 VulnHunt 配套的远程浏览器自动化工具，用于 POC/EXP 漏洞复现时自动操作浏览器。
            </span>
          </div>
          <button
            onClick={() => setHelpExpanded(!helpExpanded)}
            style={{ ...GHOST_BTN, color: "#2563eb", marginTop: "6px", fontSize: "12px" }}
          >
            {helpExpanded ? "▾" : "▸"} 如何安装和启动 DeVeye Server
          </button>
          {helpExpanded && (
            <div style={{ marginTop: "10px", fontSize: "12px", lineHeight: 1.7, color: "#374151" }}>
              <p style={{ margin: "0 0 8px" }}>1. 下载 DeVeye CLI（需版本 ≥ v1.20.0）</p>
              <p style={{ margin: "0 0 8px" }}>2. 在有 GUI + Chrome 的机器上启动 Server：</p>
              <pre style={CODE_BLOCK_STYLE}>
                deveye server start --host 0.0.0.0 --port 9888 --token &lt;your-token&gt;
              </pre>
              <p style={{ margin: "8px 0" }}>3. 确保 VulnHunt 容器能网络访问到该机器（建议填写内网 IP）</p>
              <p style={{ margin: "0" }}>4. 返回此页面，填入 URL + Token，点击"测试连接"验证</p>
            </div>
          )}
        </div>

        {/* Server URL */}
        <div>
          <label style={LABEL}>DeVeye Server URL</label>
          <input
            value={serverUrl}
            onChange={(e) => { setServerUrl(e.target.value); setTestResult(null); }}
            placeholder="ws://192.168.x.x:9888"
            style={INPUT}
          />
          <div style={HINT}>支持 ws:// 或 wss://（TLS）</div>
        </div>

        {/* Token */}
        <div>
          <label style={LABEL}>访问 Token</label>
          <div style={{ position: "relative" }}>
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => { setToken(e.target.value); setTestResult(null); }}
              placeholder="与 Server 启动时的 --token 参数一致"
              style={{ ...INPUT, paddingRight: "40px" }}
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              style={{
                position: "absolute",
                right: "8px",
                top: "50%",
                transform: "translateY(-50%)",
                ...GHOST_BTN,
                padding: "4px",
              }}
            >
              <Icon name={showToken ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
        </div>

        {/* Timeout + Concurrency row */}
        <div style={{ display: "flex", gap: "16px" }}>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>默认超时（秒）</label>
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
              min={60}
              max={7200}
              style={INPUT}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LABEL}>默认并发</label>
            <input
              type="number"
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
              min={1}
              max={5}
              style={INPUT}
            />
          </div>
        </div>

        {/* Test result */}
        {testResult && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: "6px",
              fontSize: "12px",
              lineHeight: 1.5,
              background: testResult.ok ? "#dcfce7" : "#fee2e2",
              color: testResult.ok ? "#166534" : "#991b1b",
              border: `1px solid ${testResult.ok ? "#bbf7d0" : "#fecaca"}`,
            }}
          >
            {testResult.ok ? (
              <>✓ 连接成功{testResult.server_version ? ` · DeVeye Server ${testResult.server_version}` : ""}</>
            ) : (
              <>
                ✕ 连接失败
                {testResult.error && <div style={{ marginTop: "4px", opacity: 0.8 }}>{testResult.error}</div>}
                <div style={{ marginTop: "4px", opacity: 0.7 }}>
                  提示：检查 Server 是否启动 + 防火墙端口 + Token 是否正确
                </div>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
          <button
            onClick={() => testMut.mutate()}
            disabled={!serverUrl || testMut.isPending}
            style={{
              ...GHOST_BTN,
              padding: "8px 16px",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              fontSize: "13px",
              opacity: !serverUrl || testMut.isPending ? 0.5 : 1,
            }}
          >
            {testMut.isPending ? "连接中..." : "测试连接"}
          </button>
          <button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: "6px",
              background: "var(--brand)",
              color: "var(--btn-primary-text, #fff)",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
              opacity: saveMut.isPending ? 0.6 : 1,
            }}
          >
            {saveMut.isPending ? "保存中..." : saveMut.isSuccess ? "✓ 已保存" : "保存"}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ── Styles ── */

const CARD: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  overflow: "hidden",
  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
};

const ICON_TILE: CSSProperties = {
  width: "36px",
  height: "36px",
  borderRadius: "8px",
  background: "var(--bg-page)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-secondary)",
  flexShrink: 0,
};

const LABEL: CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 600,
  color: "var(--text-primary)",
  marginBottom: "6px",
};

const INPUT: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "13px",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  outline: "none",
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const HINT: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  marginTop: "4px",
};

const GHOST_BTN: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--text-secondary)",
  fontFamily: "inherit",
  padding: 0,
};

const HELP_BANNER: CSSProperties = {
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: "8px",
  padding: "12px 14px",
};

const CODE_BLOCK_STYLE: CSSProperties = {
  margin: "4px 0",
  padding: "8px 12px",
  background: "var(--bg-page)",
  borderRadius: "4px",
  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
  fontSize: "12px",
  overflow: "auto",
};
