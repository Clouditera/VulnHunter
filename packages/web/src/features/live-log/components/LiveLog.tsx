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
  /** Optional human-readable payload fields used by various event types. */
  name?: string;
  message?: string;
  text?: string;
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

/**
 * Inject the ticker slide-in keyframe exactly once. Scoped by a fixed id
 * so React hot-reload / multiple mounts don't duplicate the <style> tag.
 */
function ensureLiveLogKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById("vh-livelog-keyframes")) return;
  const style = document.createElement("style");
  style.id = "vh-livelog-keyframes";
  style.textContent =
    "@keyframes vh-livelog-slide-in { from { transform: translateY(70%); opacity: 0 } to { transform: translateY(0); opacity: 1 } }";
  document.head.appendChild(style);
}

export function LiveLog({ taskId, taskState }: Props) {
  useEffect(() => ensureLiveLogKeyframes(), []);
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

        // Update the collapsed-row summary from ANY meaningful event, not
        // just tool_calls. Previously only tool_call events updated
        // `latestTool`, so a task emitting only `stage` / `error` / `log`
        // events would show "等待事件…" forever even though the log has
        // content — which looked like a bug to users (B7).
        if (event.type === "tool_call" && event.tool) {
          let args = event.args_summary ?? "";
          const prefix = `${event.tool}: `;
          if (args.startsWith(prefix)) args = args.slice(prefix.length);
          setLatestTool(args ? `${event.tool} → ${args}` : event.tool);
        } else if (event.type === "stage") {
          // stage events may carry the stage name in `stage`, `name`, or
          // `state` depending on producer; use whichever is present.
          const label = event.stage || event.name || event.state || "";
          setLatestTool(label ? `stage → ${label}` : "stage");
        } else if (event.type === "error") {
          const raw = event.message || event.text || "";
          const msg = raw.length > 80 ? raw.slice(0, 77) + "…" : raw;
          setLatestTool(msg ? `error → ${msg}` : "error");
        } else if (event.type === "task" && !latestTool) {
          // Bootstrap value so the strip doesn't say "等待事件…" once we
          // already have a task-started event.
          setLatestTool("task → started");
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
        {/*
          Collapsed-row ticker: when `latestTool` changes we remount this
          span via key, which triggers the slide-up-and-fade-in animation
          (U18 fish feedback — "幻灯片上下流动刷新效果").
        */}
        <span
          data-testid="live-log-current-tool"
          style={{
            flex: 1,
            minWidth: 0,
            position: "relative",
            overflow: "hidden",
            fontSize: "13px",
            fontFamily: "SF Mono, JetBrains Mono, Menlo, monospace",
            color: "var(--text-primary)",
            lineHeight: 1.4,
          }}
        >
          <span
            key={latestTool || "__empty__"}
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              animation: "vh-livelog-slide-in 0.35s cubic-bezier(0.2,0.8,0.2,1)",
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

      {/* Expanded state — Phase 11 #18 fish feedback: light-themed, unified
          palette with the rest of the app. Semantic event colors carry meaning
          via prefix font color only, so the panel still reads as a calm
          white card rather than a dark terminal. */}
      {expanded && (
        <div
          data-testid="live-log-expanded"
          style={{
            marginTop: "8px",
            background: "var(--bg-card)",
            border: "1px solid var(--divider)",
            borderRadius: "8px",
            overflow: "hidden",
          }}
        >
          {/* Source tabs — pill style matching Tasks page filters */}
          <div
            style={{
              display: "flex",
              gap: "6px",
              alignItems: "center",
              padding: "8px 12px",
              borderBottom: "1px solid var(--divider)",
            }}
          >
            {["all", ...sources].map((src) => {
              const active = activeSource === src;
              return (
                <button
                  key={src}
                  data-testid={`live-log-tab-${src}`}
                  onClick={() => setActiveSource(src)}
                  style={{
                    padding: "4px 12px",
                    border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                    borderRadius: "999px",
                    background: active ? "var(--bg-page)" : "transparent",
                    color: active
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                    fontSize: "12px",
                    fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    fontFamily: "inherit",
                  }}
                >
                  {src === "all" ? (
                    i18n.t("liveLog.allSources")
                  ) : (
                    <span>
                      <span
                        style={{
                          display: "inline-block",
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: sourceColor(src),
                          marginRight: "5px",
                          verticalAlign: "1px",
                        }}
                      />
                      {src}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              data-testid="live-log-autoscroll"
              data-on={autoScroll || undefined}
              onClick={() => {
                setAutoScroll((v) => !v);
                if (!autoScroll && streamRef.current) {
                  streamRef.current.scrollTop =
                    streamRef.current.scrollHeight;
                }
              }}
              title={i18n.t("liveLog.autoscroll")}
              style={{
                marginLeft: "auto",
                padding: "4px 10px",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                background: autoScroll
                  ? "var(--bg-page)"
                  : "var(--bg-card)",
                color: autoScroll
                  ? "var(--text-primary)"
                  : "var(--text-secondary)",
                fontSize: "11px",
                fontWeight: 500,
                cursor: "pointer",
                fontFamily: "inherit",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              <span>⇩</span>
              {i18n.t("liveLog.autoscroll")}
            </button>
          </div>

          {/* Event stream — white bg, semantic event prefix colors. */}
          <div
            ref={streamRef}
            style={{
              height: "340px",
              overflow: "auto",
              padding: "6px 0",
              fontFamily: "SF Mono, JetBrains Mono, Menlo, monospace",
              fontSize: "12.5px",
              lineHeight: 1.75,
              background: "var(--bg-card)",
              color: "var(--text-primary)",
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 50;
              if (atBottom !== autoScroll) setAutoScroll(atBottom);
            }}
          >
            {filteredEvents.length === 0 ? (
              <div
                style={{
                  color: "var(--text-secondary)",
                  padding: "12px 18px",
                  fontSize: "12.5px",
                }}
              >
                {i18n.t("liveLog.noEvents")}
              </div>
            ) : (
              filteredEvents.map((ev, i) => (
                <LogLine key={`${ev.seq}-${i}`} ev={ev} />
              ))
            )}
          </div>

          {!autoScroll && isRunning && (
            <div
              style={{
                position: "sticky",
                bottom: 0,
                padding: "6px 12px",
                background: "var(--bg-page)",
                borderTop: "1px solid var(--divider)",
                color: "var(--text-primary)",
                fontSize: "11px",
                cursor: "pointer",
                textAlign: "center",
                fontWeight: 500,
              }}
              onClick={() => {
                setAutoScroll(true);
                if (streamRef.current) {
                  streamRef.current.scrollTop =
                    streamRef.current.scrollHeight;
                }
              }}
            >
              ↓ {i18n.t("liveLog.resumeScroll")}
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

  // Light-palette semantic colors (fish #18 feedback):
  // task = green, stage = amber-brown, tool = blue, error = red.
  // Subtle full-row background tint for error/stage so attention-worthy
  // events pop without looking like a dark terminal.
  let rowBg: string | undefined;
  let toolColor = "var(--sev-low)"; // #2563eb blue

  if (ev.type === "tool_call") {
    icon =
      ev.status === "error"
        ? { char: "✕", color: "#dc2626" }
        : ev.status === "success"
          ? { char: "✓", color: "#16a34a" }
          : { char: "⋯", color: "#b45309", pulse: true };
    tool = ev.tool ?? "";
    let a = ev.args_summary ?? "";
    if (tool && a.startsWith(`${tool}: `)) a = a.slice(tool.length + 2);
    param = a;
    toolColor = "#2563eb";
    if (ev.status === "error") {
      rowBg = "rgba(220,38,38,0.03)";
      toolColor = "#dc2626";
    }
  } else if (ev.type === "stage_start") {
    icon = { char: "▸", color: "#b45309" };
    tool = "stage";
    param = `${ev.stage ?? ""} starting`;
    dur = undefined;
    toolColor = "#b45309";
    rowBg = "rgba(180,83,9,0.025)";
  } else if (ev.type === "stage_end") {
    icon = { char: "✓", color: "#16a34a" };
    tool = "stage";
    param = `${ev.stage ?? ""} done`;
    dur = undefined;
    toolColor = "#16a34a";
  } else if (ev.type === "task_status" || ev.type === "task") {
    icon = { char: "●", color: "#16a34a" };
    tool = "task";
    param = ev.state ?? "";
    dur = undefined;
    toolColor = "#16a34a";
  } else if (ev.type === "error") {
    icon = { char: "✕", color: "#dc2626" };
    tool = "error";
    param =
      (ev as LiveLogEvent & { summary?: string; message?: string }).summary ??
      (ev as LiveLogEvent & { message?: string }).message ??
      "unknown";
    dur = undefined;
    toolColor = "#dc2626";
    rowBg = "rgba(220,38,38,0.03)";
  } else {
    icon = { char: "·", color: "var(--text-secondary)" };
    tool = ev.type;
    param = "";
    dur = undefined;
    toolColor = "var(--text-secondary)";
  }

  return (
    <div
      data-testid="live-log-entry"
      data-event-type={ev.type}
      style={{
        display: "grid",
        gridTemplateColumns: "72px 18px 1fr",
        gap: "6px",
        alignItems: "baseline",
        padding: "2px 14px",
        background: rowBg,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      <span
        data-testid="log-entry-timestamp"
        style={{
          color: "var(--text-secondary)",
          opacity: 0.75,
          fontSize: "11.5px",
        }}
      >
        {ts}
      </span>
      <span
        style={{
          textAlign: "center",
          color: icon.color,
          fontWeight: 700,
          animation: icon.pulse ? "ls-pulse 1.2s infinite" : undefined,
        }}
      >
        {icon.char}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {tool && (
          <span
            data-testid="log-entry-tool"
            style={{ color: toolColor, fontWeight: 600 }}
          >
            {tool}
          </span>
        )}
        {param && (
          <span style={{ color: "var(--text-secondary)" }}> {param}</span>
        )}
        {dur != null && (
          <span
            data-testid="log-entry-status"
            style={{
              color: "var(--text-secondary)",
              marginLeft: "8px",
              opacity: 0.6,
            }}
          >
            · {dur}ms
          </span>
        )}
      </span>
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
