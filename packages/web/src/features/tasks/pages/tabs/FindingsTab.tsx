import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Task, type FindingMeta } from "../../../../shared/api/client.js";
import { i18n } from "../../../../shared/i18n/index.js";

const SEV_COLORS: Record<string, string> = {
  high: "var(--sev-high)", medium: "var(--sev-medium)", low: "var(--sev-low)", info: "var(--sev-info)",
};

export function FindingsTab() {
  const { task } = useOutletContext<{ task: Task }>();
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [, forceUpdate] = useState(0);
  useEffect(() => i18n.onChange(() => forceUpdate((n) => n + 1)), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(40); // percent
  const [dragging, setDragging] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["findings", task.id, severityFilter],
    queryFn: () =>
      api.findings.list(task.id, severityFilter === "all" ? undefined : severityFilter),
  });

  const findings = data?.findings ?? [];
  const selectedFinding = findings.find((f) => f.id === selected);

  function handleSplitterMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);

    function onMouseMove(mv: MouseEvent) {
      const container = document.querySelector("[data-testid='findings-container']") as HTMLElement;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = ((mv.clientX - rect.left) / rect.width) * 100;
      // Enforce absolute 320px minimum regardless of container width
      const minPct = rect.width > 0 ? (320 / rect.width) * 100 : 25;
      const clamped = Math.max(minPct, Math.min(60, pct));
      setLeftWidth(clamped);
    }

    function onMouseUp() {
      setDragging(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div data-testid="task-detail-panel-findings" style={{ position: "relative" }}>
      {/* Filter bar */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
        {["all", "high", "medium", "low", "info"].map((s) => (
          <button
            key={s}
            data-testid={`findings-filter-${s}`}
            onClick={() => setSeverityFilter(s)}
            style={{
              padding: "4px 10px",
              border: `1px solid ${severityFilter === s && s !== "all" ? SEV_COLORS[s] : severityFilter === s ? "var(--brand)" : "var(--border)"}`,
              borderRadius: "6px",
              background: severityFilter === s ? "var(--bg-active-filter)" : "transparent",
              color: s === "all" ? (severityFilter === "all" ? "var(--brand)" : "var(--text-secondary)") : severityFilter === s ? SEV_COLORS[s] : "var(--text-secondary)",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {s}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: "12px", color: "var(--text-secondary)", alignSelf: "center" }}>
          {findings.length} {i18n.t("findings.count")}
        </span>
      </div>

      {/* Split container */}
      <div
        data-testid="findings-container"
        style={{ display: "flex", gap: "0", height: "calc(100vh - 360px)", minHeight: "400px" }}
      >
        {/* Left: findings list */}
        <div
          data-testid="findings-left-panel"
          style={{
            width: `${leftWidth}%`,
            flexShrink: 0,
            overflow: "auto",
            background: "var(--bg-card)",
            borderRadius: "10px 0 0 10px",
            border: "1px solid var(--border)",
            borderRight: "none",
          }}
        >
          {isLoading ? (
            <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("findings.loading")}</div>
          ) : findings.length === 0 ? (
            <div style={{ padding: "24px", color: "var(--text-secondary)", fontSize: "13px" }}>{i18n.t("findings.empty")}</div>
          ) : (
            findings.map((f: FindingMeta) => (
              <div
                key={f.id}
                data-testid="finding-row"
                data-finding-id={f.id}
                data-severity={f.severity}
                onClick={() => setSelected(f.id === selected ? null : f.id)}
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--divider)",
                  cursor: "pointer",
                  background: selected === f.id ? "var(--bg-page)" : "transparent",
                  borderLeft: selected === f.id ? `3px solid var(--brand)` : "3px solid transparent",
                  transition: "all 0.1s",
                }}
              >
                <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: SEV_COLORS[f.severity],
                      flexShrink: 0,
                      marginTop: "4px",
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.finding_key}
                    </div>
                    <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "2px" }}>
                      {f.vuln_type_full ?? f.vuln_type ?? ""}
                    </div>
                    {f.primary_file && (
                      <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontFamily: "monospace", marginTop: "2px" }}>
                        {f.primary_file}{f.primary_line ? `:${f.primary_line}` : ""}
                      </div>
                    )}

                    {/* Expanded: description placeholder */}
                    {selected === f.id && (
                      <div
                        data-testid="finding-detail-panel"
                        style={{ marginTop: "12px", padding: "12px", background: "var(--bg-page)", borderRadius: "6px", fontSize: "12px" }}
                      >
                        <div style={{ color: "var(--text-secondary)", marginBottom: "8px", fontWeight: 600 }}>{i18n.t("findings.description")}</div>
                        <div style={{ color: "var(--text-secondary)" }}>
                          Load full finding detail from <code>/api/tasks/{task.id}/findings/{f.finding_key}</code>
                        </div>
                        <div style={{ color: "var(--text-secondary)", marginTop: "12px", fontWeight: 600 }}>{i18n.t("findings.remediation")}</div>
                        <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
                          See finding YAML for fix_recommendation.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Splitter */}
        <div
          data-testid="findings-splitter"
          onMouseDown={handleSplitterMouseDown}
          onDoubleClick={() => setLeftWidth(40)}
          style={{
            width: "6px",
            flexShrink: 0,
            background: dragging ? "var(--brand)" : "var(--border)",
            cursor: "col-resize",
            transition: dragging ? "none" : "background 0.15s",
          }}
          title="Double-click to reset 40/60"
        />

        {/* Right: code viewer */}
        <div
          data-testid="findings-right-panel"
          style={{
            flex: 1,
            overflow: "auto",
            background: "var(--code-bg)",
            borderRadius: "0 10px 10px 0",
            border: "1px solid var(--border)",
            borderLeft: "none",
          }}
        >
          {selectedFinding ? (
            <div style={{ padding: "16px" }}>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--code-comment)",
                  fontFamily: "monospace",
                  marginBottom: "12px",
                  padding: "6px 10px",
                  background: "var(--terminal-bg)",
                  borderRadius: "4px",
                }}
              >
                {selectedFinding.primary_file ?? "unknown file"}
                {selectedFinding.primary_line ? `:${selectedFinding.primary_line}` : ""}
              </div>
              <div
                style={{
                  fontFamily: "monospace",
                  fontSize: "12px",
                  color: "var(--code-text)",
                  lineHeight: 1.6,
                }}
              >
                {/* Placeholder code view — real implementation uses workspace API */}
                <div style={{ color: "var(--code-comment)", marginBottom: "8px" }}>
                  {/* Line context would be loaded from /api/tasks/:id/workspace/file */}
                  Line {selectedFinding.primary_line} of {selectedFinding.primary_file}
                </div>
                <div
                  style={{
                    background: "rgba(220,38,38,0.12)",
                    borderLeft: "3px solid var(--brand)",
                    padding: "4px 12px",
                    borderRadius: "2px",
                  }}
                >
                  ⚠ {selectedFinding.finding_key}
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--code-comment)",
                fontSize: "13px",
                fontFamily: "monospace",
              }}
            >
              {i18n.t("findings.selectToView")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
