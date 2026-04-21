import { useState, useEffect, useRef } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";

export interface LiveLogEvent {
  type: string;
  source: string;
  seq: number;
  ts: string;
  tool?: string;
  args_summary?: string;
  duration_ms?: number;
  status?: string;
  stage?: string;
  state?: string;
}

interface Props {
  taskId: string;
  taskState: string;
}

const SOURCE_COLORS: Record<string, string> = {
  scan: "var(--status-running)",
  report: "#7c3aed",
};

function sourceColor(src: string): string {
  if (src === "scan") return SOURCE_COLORS.scan;
  if (src.startsWith("report")) return SOURCE_COLORS.report;
  return "var(--log-text-dim)";
}

export function LiveLog({ taskId, taskState }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<LiveLogEvent[]>([]);
  const [sources, setSources] = useState<string[]>(["scan"]);
  const [activeSource, setActiveSource] = useState<string>("all");
  const [latestTool, setLatestTool] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const streamRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isRunning = taskState === "running";
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/live-log`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", task_id: taskId, since_seq: -1 }));
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as LiveLogEvent;
        if (event.type === "ping" || event.type === "snapshot_end") return;

        setEvents((prev) => {
          const next = [...prev, event].slice(-1000);
          return next;
        });

        if (event.source && !sources.includes(event.source)) {
          setSources((prev) => (prev.includes(event.source) ? prev : [...prev, event.source]));
        }

        if (event.type === "tool_call" && event.tool) {
          // args_summary sometimes arrives as "<tool>: <args>" (youngflow);
          // strip the redundant tool prefix so the bar doesn't read "bash → bash: ls".
          let args = event.args_summary ?? "";
          const prefix = `${event.tool}: `;
          if (args.startsWith(prefix)) args = args.slice(prefix.length);
          setLatestTool(args ? `${event.tool} → ${args}` : event.tool);
        }
      } catch {}
    };

    return () => {
      ws.close();
    };
  }, [taskId]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const filteredEvents =
    activeSource === "all"
      ? events
      : events.filter((e) => e.source === activeSource);

  // Parse "tool → param" into two parts for colored display.
  const toolParts = (() => {
    if (!latestTool) return null;
    const m = latestTool.match(/^(\S+)\s*→\s*(.*)$/);
    if (m) return { tool: m[1], param: m[2] };
    return { tool: latestTool, param: "" };
  })();

  return (
    <div
      data-testid="live-log-bar"
      style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--divider)" }}
    >
      {/* Collapsed row */}
      <div
        data-testid="live-log-expand-btn"
        onClick={() => setExpanded((e) => !e)}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        style={{
          height: "36px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 8px",
          borderRadius: "6px",
          cursor: "pointer",
          userSelect: "none",
          transition: "background 0.15s",
        }}
      >
        {/*
          Wrapper must be a flex/inline-flex container, not a bare <span>:
          a bare span inherits the parent's line-height and pushes the pill
          ~4px below its visual center in a 36px flex row.
        */}
        <span
          data-testid="live-log-status-badge"
          data-status={taskState}
          style={{
            display: "inline-flex",
            alignItems: "center",
            lineHeight: 0,
            flexShrink: 0,
          }}
        >
          <StatusPill state={taskState} size="sm" />
        </span>
        <span
          data-testid="live-log-current-tool"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "13px",
            fontFamily: "SF Mono, JetBrains Mono, Menlo, monospace",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: 1.4,
          }}
        >
          {toolParts ? (
            <>
              <span style={{ color: "var(--sev-low)", fontWeight: 600 }}>{toolParts.tool}</span>
              {toolParts.param && (
                <>
                  <span style={{ color: "var(--text-secondary)", margin: "0 6px" }}>→</span>
                  <span style={{ color: "var(--text-secondary)" }}>{toolParts.param}</span>
                </>
              )}
            </>
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>
              {isRunning ? i18n.t("liveLog.waiting") : i18n.t("liveLog.noEvents")}
            </span>
          )}
        </span>
        <span
          data-testid="live-log-event-count"
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {events.length} {i18n.t("liveLog.events")}
        </span>
        <span
          style={{
            width: "22px",
            height: "22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-secondary)",
            flexShrink: 0,
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform 0.2s",
          }}
        >
          <Icon name="chevron-down" size={14} />
        </span>
      </div>

      {/* Expanded state */}
      {expanded && (
        <div
          data-testid="live-log-expanded"
          style={{
            marginTop: "8px",
            background: "var(--terminal-bg)",
            borderRadius: "6px",
            overflow: "hidden",
          }}
        >
          {/* Source tabs */}
          <div style={{ display: "flex", gap: "0", borderBottom: "1px solid var(--log-tab-border)", padding: "0 8px" }}>
            {["all", ...sources].map((src) => (
              <button
                key={src}
                data-testid={`live-log-tab-${src}`}
                onClick={() => setActiveSource(src)}
                style={{
                  padding: "6px 12px",
                  border: "none",
                  background: "transparent",
                  color: activeSource === src ? "var(--log-tab-active)" : "var(--log-tab-inactive)",
                  borderBottom: activeSource === src ? "2px solid var(--log-tab-active)" : "2px solid transparent",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {src === "all" ? i18n.t("liveLog.allSources") : (
                  <span>
                    <span style={{ color: sourceColor(src), marginRight: "4px" }}>●</span>
                    {src}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Event stream — single-line format matching prototype .lls-line */}
          <div
            ref={streamRef}
            style={{
              height: "340px",
              overflow: "auto",
              padding: "14px 18px",
              fontFamily: "SF Mono, JetBrains Mono, Menlo, monospace",
              fontSize: "12px",
              lineHeight: 1.85,
              color: "var(--code-text)",
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
              setAutoScroll(atBottom);
            }}
          >
            {filteredEvents.length === 0 ? (
              <div style={{ color: "var(--log-text-dim)", padding: "6px 0" }}>
                {i18n.t("liveLog.noEvents")}
              </div>
            ) : (
              filteredEvents.map((ev, i) => (
                <LogLine key={`${ev.seq}-${i}`} ev={ev} />
              ))
            )}
          </div>

          {/* Auto-scroll hint */}
          {!autoScroll && isRunning && (
            <div
              style={{
                position: "sticky",
                bottom: 0,
                padding: "6px 12px",
                background: "var(--log-pill-bg)",
                color: "var(--log-pill-text)",
                fontSize: "11px",
                cursor: "pointer",
                textAlign: "center",
              }}
              onClick={() => {
                setAutoScroll(true);
                if (streamRef.current) {
                  streamRef.current.scrollTop = streamRef.current.scrollHeight;
                }
              }}
            >
              ↓ {events.length - filteredEvents.length} new events — click to resume
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Single-line log entry matching prototype .lls-line:
 * `[HH:MM:SS]  {✓|✕|⋯}  {tool}({args_summary}) · {duration}ms`
 * Non-tool_call events (stage_start, stage_end, task_status, error)
 * use the same skeleton with an appropriate icon + label.
 */
function LogLine({ ev }: { ev: LiveLogEvent }) {
  const ts = new Date(ev.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  let icon: { char: string; color: string; pulse?: boolean };
  let tool = "";
  let param = "";
  let dur = ev.duration_ms;

  if (ev.type === "tool_call") {
    icon = ev.status === "error"
      ? { char: "✕", color: "#ef4444" }
      : ev.status === "success"
        ? { char: "✓", color: "#10b981" }
        : { char: "⋯", color: "#f59e0b", pulse: true };
    tool = ev.tool ?? "";
    // strip redundant "<tool>: " prefix from youngflow args_summary
    let a = ev.args_summary ?? "";
    if (tool && a.startsWith(`${tool}: `)) a = a.slice(tool.length + 2);
    param = a;
  } else if (ev.type === "stage_start") {
    icon = { char: "▸", color: "#f59e0b" };
    tool = "stage";
    param = `${ev.stage ?? ""} starting`;
    dur = undefined;
  } else if (ev.type === "stage_end") {
    icon = { char: "✓", color: "#10b981" };
    tool = "stage";
    param = `${ev.stage ?? ""} done`;
    dur = undefined;
  } else if (ev.type === "task_status") {
    icon = { char: "●", color: "#93c5fd" };
    tool = "task";
    param = ev.state ?? "";
    dur = undefined;
  } else if (ev.type === "error") {
    icon = { char: "✕", color: "#ef4444" };
    tool = "error";
    param = (ev as LiveLogEvent & { summary?: string }).summary ?? "unknown";
    dur = undefined;
  } else {
    icon = { char: "·", color: "#737373" };
    tool = ev.type;
    param = "";
    dur = undefined;
  }

  return (
    <div
      data-testid="live-log-entry"
      style={{
        display: "block",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <span data-testid="log-entry-timestamp" style={{ color: "#6b7280", marginRight: "10px" }}>
        [{ts}]
      </span>
      <span
        style={{
          display: "inline-block",
          width: "14px",
          textAlign: "center",
          marginRight: "6px",
          color: icon.color,
          animation: icon.pulse ? "ls-pulse 1.2s infinite" : undefined,
        }}
      >
        {icon.char}
      </span>
      {tool && (
        <span data-testid="log-entry-tool" style={{ color: "#93c5fd", fontWeight: 600 }}>
          {tool}
        </span>
      )}
      {param && (
        <>
          <span style={{ color: "#d4d4d4" }}>({param})</span>
        </>
      )}
      {dur != null && (
        <span
          data-testid="log-entry-status"
          style={{ color: "#737373", marginLeft: "8px" }}
        >
          · {dur}ms
        </span>
      )}
    </div>
  );
}

// Keyframes for pending icon pulse — inject once.
if (typeof document !== "undefined" && !document.getElementById("ls-pulse-keyframes")) {
  const styleTag = document.createElement("style");
  styleTag.id = "ls-pulse-keyframes";
  styleTag.textContent = `@keyframes ls-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.4; transform:scale(0.82); } }`;
  document.head.appendChild(styleTag);
}
