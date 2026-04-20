import { useState, useEffect, useRef } from "react";

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
  scan: "#2563eb",
  report: "#7c3aed",
};

function sourceColor(src: string): string {
  if (src === "scan") return SOURCE_COLORS.scan;
  if (src.startsWith("report")) return SOURCE_COLORS.report;
  return "#737373";
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

  useEffect(() => {
    const host = window.location.hostname;
    const wsUrl = `ws://${host}:${parseInt(window.location.port || "3000") > 3000 ? window.location.port : "8080"}/ws/live-log`;
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
          setLatestTool(`${event.tool} → ${event.args_summary ?? ""}`);
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

  const statusColor = isRunning ? "#16a34a" : taskState === "failed" ? "#dc2626" : "#737373";
  const statusDot = isRunning ? "●" : taskState === "failed" ? "✕" : "✓";

  return (
    <div data-testid="live-log-bar" style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--divider)" }}>
      {/* Collapsed row */}
      <div
        style={{
          height: "36px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          cursor: "pointer",
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        {/* Status badge */}
        <span
          data-testid="live-log-status"
          data-status={taskState}
          style={{
            color: statusColor,
            fontSize: "12px",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: "4px",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              animation: isRunning ? "pulse 1.5s infinite" : "none",
              display: "inline-block",
            }}
          >
            {statusDot}
          </span>
          {taskState.charAt(0).toUpperCase() + taskState.slice(1)}
        </span>

        {/* Latest tool call */}
        <span
          data-testid="live-log-current-tool"
          style={{
            flex: 1,
            fontSize: "12px",
            color: "var(--text-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "monospace",
          }}
        >
          {latestTool || (isRunning ? "Waiting for events…" : "No events")}
        </span>

        {/* Count + expand icon */}
        <span style={{ fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
          {events.length} events
        </span>
        <span style={{ fontSize: "12px", color: "var(--text-secondary)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
          ▾
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
          <div style={{ display: "flex", gap: "0", borderBottom: "1px solid #333", padding: "0 8px" }}>
            {["all", ...sources].map((src) => (
              <button
                key={src}
                data-testid={`live-log-tab-${src}`}
                onClick={() => setActiveSource(src)}
                style={{
                  padding: "6px 12px",
                  border: "none",
                  background: "transparent",
                  color: activeSource === src ? "#fff" : "#737373",
                  borderBottom: activeSource === src ? "2px solid #fff" : "2px solid transparent",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {src === "all" ? "All" : (
                  <span>
                    <span style={{ color: sourceColor(src), marginRight: "4px" }}>●</span>
                    {src}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Event stream */}
          <div
            ref={streamRef}
            style={{ height: "320px", overflow: "auto", padding: "8px", fontFamily: "monospace", fontSize: "11px" }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
              setAutoScroll(atBottom);
            }}
          >
            {filteredEvents.length === 0 ? (
              <div style={{ color: "#737373", padding: "16px" }}>No events yet…</div>
            ) : (
              filteredEvents.map((ev, i) => (
                <div key={`${ev.seq}-${i}`} style={{ display: "flex", gap: "8px", marginBottom: "3px" }}>
                  <span style={{ color: "#555", flexShrink: 0 }}>
                    {new Date(ev.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                  <span style={{ color: sourceColor(ev.source), flexShrink: 0 }}>[{ev.source}]</span>
                  {ev.type === "tool_call" && (
                    <>
                      <span style={{ color: "#e5e5e5" }}>{ev.tool}</span>
                      {ev.args_summary && <span style={{ color: "#737373" }}>{ev.args_summary}</span>}
                      {ev.duration_ms && (
                        <span style={{ color: ev.status === "success" ? "#16a34a" : "#dc2626" }}>
                          {ev.duration_ms}ms
                        </span>
                      )}
                    </>
                  )}
                  {ev.type === "stage_start" && (
                    <span style={{ color: "#ca8a04" }}>[{ev.stage}] starting</span>
                  )}
                  {ev.type === "stage_end" && (
                    <span style={{ color: "#16a34a" }}>[{ev.stage}] done</span>
                  )}
                  {ev.type === "task_status" && (
                    <span style={{ color: "#e5e5e5", fontWeight: 600 }}>Task {ev.state}</span>
                  )}
                  {ev.type === "error" && (
                    <span style={{ color: "#dc2626" }}>ERROR: {(ev as LiveLogEvent & { summary?: string }).summary ?? "unknown"}</span>
                  )}
                </div>
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
                background: "#333",
                color: "#e5e5e5",
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
