import { useState, useEffect, useRef } from "react";
import { i18n } from "../../../shared/i18n/index.js";
import { Icon } from "../../../shared/components/Icon.js";
import { StatusPill } from "../../../shared/components/StatusPill.js";
import { api } from "../../../shared/api/client.js";

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
  // "Active" states keep a live WS subscription for streaming events.
  // Terminal states (completed/failed/cancelled) load history from the
  // REST archive endpoint instead — in-memory buffer is empty / evicted
  // by then, and WS would just show "暂无事件" forever (fish #20 bug).
  const isActive =
    taskState === "running" ||
    taskState === "queued" ||
    taskState === "paused" ||
    taskState === "resuming";
  const [, forceI18n] = useState(0);
  useEffect(() => i18n.onChange(() => forceI18n((n) => n + 1)), []);

  // History load for terminal tasks — reads from MinIO
  // `.youngflow/logs/youngflow.service.jsonl` archive via REST.
  useEffect(() => {
    if (isActive) return; // Active tasks use WS path below.
    let cancelled = false;
    api.tasks
      .events(taskId)
      .then((res) => {
        if (cancelled) return;
        // Backend wraps each event as { seq, event: { ... } } for ordering;
        // unwrap to the inner canonical event before handing to the renderer.
        const list = (res.events ?? [])
          .map((row: Record<string, unknown>) => {
            const inner = (row?.event as LiveLogEvent | undefined) ?? null;
            return inner ?? (row as unknown as LiveLogEvent);
          })
          .filter(Boolean);
        // Cap at 1000 like the WS path does, keeping the latest tail —
        // archives can be many thousands of events for a long scan.
        const tail = list.slice(-1000);
        setEvents(tail);
        // Populate the source filter chips from what's actually present.
        const srcs = Array.from(
          new Set(tail.map((e) => e.source).filter(Boolean) as string[]),
        );
        if (srcs.length > 0) setSources(srcs);
        // Bootstrap the collapsed-row summary with the last meaningful
        // event so the strip says something useful instead of
        // "等待事件…" on a finished task.
        // Backend uses both "task" and "task_status" for the same kind of
         // event — also normalise stage_start/stage_end → "stage".
        const last = [...tail]
          .reverse()
          .find(
            (e) =>
              e.type === "tool_call" ||
              e.type === "stage" ||
              e.type === "stage_start" ||
              e.type === "stage_end" ||
              e.type === "error" ||
              e.type === "task" ||
              e.type === "task_status",
          );
        if (last) {
          if (last.type === "tool_call" && last.tool) {
            let args = last.args_summary ?? "";
            const prefix = `${last.tool}: `;
            if (args.startsWith(prefix)) args = args.slice(prefix.length);
            setLatestTool(args ? `${last.tool} → ${args}` : last.tool);
          } else if (
            last.type === "stage" ||
            last.type === "stage_start" ||
            last.type === "stage_end"
          ) {
            const label = last.stage || last.name || last.state || "";
            const suffix = last.type === "stage_start" ? " starting" : last.type === "stage_end" ? " done" : "";
            setLatestTool(label ? `stage → ${label}${suffix}` : "stage");
          } else if (last.type === "error") {
            const raw = last.message || last.text || "";
            const msg = raw.length > 80 ? raw.slice(0, 77) + "…" : raw;
            setLatestTool(msg ? `error → ${msg}` : "error");
          } else {
            // task / task_status
            setLatestTool(`task → ${last.state ?? last.status ?? "finished"}`);
          }
        }
      })
      .catch(() => {
        /* leave events empty — the empty state handles this gracefully. */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, isActive]);

  useEffect(() => {
    if (!isActive) return; // Terminal tasks load via REST above.
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
        } else if (event.type === "poc_output") {
          const msg = event.message || "";
          const truncated = msg.length > 60 ? msg.slice(0, 57) + "…" : msg;
          if (truncated) setLatestTool(`poc → ${truncated}`);
        } else if (event.type === "poc_exit") {
          const exitEv = event as LiveLogEvent & { exit_code?: number };
          const ok = exitEv.exit_code === 0;
          setLatestTool(ok ? "poc → completed" : `poc → failed (exit ${exitEv.exit_code})`);
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
  }, [taskId, isActive]);

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
      data-expanded={expanded || undefined}
      style={{
        marginTop: "20px",
        // Unified card — header + expanded body live inside the same
        // border, so they read as one block instead of two separate
        // widgets (fish feedback on the prototype split).
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "10px",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
      }}
    >
      {/* Collapsed header row — part of the same card. */}
      <div
        data-testid="live-log-expand-btn"
        onClick={() => setExpanded((e) => !e)}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "var(--bg-hover)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "transparent")
        }
        style={{
          height: "44px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 14px",
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

      {/* Expanded state — always rendered, collapsed via max-height so we
          get the smooth up/down reveal animation (fish feedback #18 v3). */}
      <div
        data-testid="live-log-expanded"
        aria-hidden={!expanded}
        style={{
          maxHeight: expanded ? "460px" : 0,
          overflow: "hidden",
          transition: "max-height 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)",
          borderTop: expanded ? "1px solid var(--divider)" : "none",
          background: "var(--bg-card)",
          opacity: expanded ? 1 : 0,
          transitionProperty: "max-height, opacity, border-color",
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
  // Show per-event duration only when the value looks like a real per-call
  // elapsed time. Backend currently sometimes emits cumulative wall-clock
  // since task start (e.g. 156000ms for a 1s `bash ls`), which is misleading
  // — so we hide anything >= 2 min as likely suspect, and anything < 1s as
  // noise. Formatting: 1s ≤ d < 60s → "2.3s"; 60s ≤ d < 120s → "1m 23s".
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
  } else if (ev.type === "poc_output") {
    const pocEv = ev as LiveLogEvent & { stream?: string; message?: string };
    const isStderr = pocEv.stream === "stderr";
    icon = { char: isStderr ? "⚠" : "▸", color: isStderr ? "#d97706" : "var(--text-secondary)" };
    tool = "";
    param = pocEv.message ?? "";
    dur = undefined;
    toolColor = isStderr ? "#d97706" : "var(--text-primary)";
    if (isStderr) rowBg = "rgba(217,119,6,0.03)";
  } else if (ev.type === "poc_exit") {
    const exitEv = ev as LiveLogEvent & { exit_code?: number; duration_ms?: number };
    const ok = exitEv.exit_code === 0;
    icon = ok ? { char: "✓", color: "#16a34a" } : { char: "✕", color: "#dc2626" };
    tool = "poc";
    param = ok ? `completed` : `failed (exit ${exitEv.exit_code})`;
    dur = exitEv.duration_ms;
    toolColor = ok ? "#16a34a" : "#dc2626";
    if (!ok) rowBg = "rgba(220,38,38,0.03)";
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
        {(() => {
          const txt = formatDuration(dur);
          if (!txt) return null;
          return (
            <span
              data-testid="log-entry-duration"
              style={{
                color: "var(--text-secondary)",
                marginLeft: "8px",
                opacity: 0.6,
              }}
            >
              · {txt}
            </span>
          );
        })()}
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

/**
 * Format a duration in milliseconds for display next to a log line.
 *
 * Rules (fish feedback):
 *   - null / undefined / < 1s  → hidden (sub-second durations are noise)
 *   - 1s ≤ d < 60s             → "2.3s" (one decimal)
 *   - 60s ≤ d < 120s           → "1m 23s" (still plausibly a real call)
 *   - d ≥ 120s                 → hidden (backend currently emits cumulative
 *                                 wall-clock; likely not a real per-call time)
 *
 * The 120s ceiling is a heuristic to suppress the misleading values we saw
 * in the field (156000ms for a `bash ls`). Remove the ceiling once the
 * backend tool_execution_end carries a true per-call `elapsed_ms`.
 */
function formatDuration(ms: number | undefined | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return null;
  if (ms >= 120_000) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
