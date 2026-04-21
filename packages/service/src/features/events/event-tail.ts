/**
 * EventTail: tails a .service.jsonl file from a worker volume,
 * parses lines as LiveLogEvent, appends to the task ring buffer.
 *
 * youngflow writes: <output_dir>/.youngflow/logs/<stage>.service.jsonl
 * bridge writes:    /workspace/.report/events.jsonl (chat/report workers)
 */

import { createReadStream, existsSync, statSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { logger } from "../../infra/logger.js";
import { appendEvent } from "./event-store.js";
import { broadcastEvent } from "./ws-live-log.js";
import type { LiveLogEvent } from "@vulnhunt/shared";

const POLL_INTERVAL_MS = 500;

/**
 * Translate youngflow NDJSON event (has 'event' field) → canonical LiveLogEvent (has 'type' field).
 * Returns null for events that should not be forwarded (debug, checkpoint, etc.).
 */
function translateYoungflowEvent(raw: Record<string, unknown>, source: string): LiveLogEvent | null {
  const event = raw.event as string;
  const ts = (raw.ts as string) ?? new Date().toISOString();
  const stage = (raw.stage as string) ?? "";
  const base = { source, seq: 0, ts, stage };

  switch (event) {
    case "stage_start":
      return { ...base, type: "stage_start" } as LiveLogEvent;
    case "stage_done":
      return { ...base, type: "stage_end", status: (raw.exit_code ?? 0) === 0 ? "success" : "error",
        duration_ms: (raw.duration_ms as number) ?? 0 } as LiveLogEvent;
    case "stage_skipped":
      return { ...base, type: "stage_end", status: "success", duration_ms: 0 } as LiveLogEvent;
    case "tool_call":
      return { ...base, type: "tool_call",
        tool: (raw.tool as string) ?? "",
        args_summary: (raw.args_summary as string) ?? "",
        duration_ms: ((raw.elapsed_s as number) ?? 0) * 1000,
        status: raw.status === "ok" ? "success" : (raw.status as string) ?? "success",
      } as LiveLogEvent;
    case "flow_start":
      return { ...base, type: "task_status", status: "running" } as unknown as LiveLogEvent;
    case "flow_end":
      return { ...base, type: "task_status",
        status: (raw.stages_failed as number) > 0 ? "failed" : "completed" } as unknown as LiveLogEvent;
    case "api_error": case "extension_error": case "process_error":
    case "idle_timeout": case "timeout":
      return { ...base, type: "error",
        summary: (raw.error ?? raw.message ?? raw.reason ?? event) as string } as LiveLogEvent;
    case "retry": case "auto_retry":
      return { ...base, type: "error",
        summary: `${(raw.reason as string) ?? ""} (attempt ${raw.attempt}/${raw.max_attempts})` } as LiveLogEvent;
    default:
      return null; // debug, checkpoint_*, dispatch, route, report_refresh
  }
}

export class FileTail {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = true;

  constructor(
    private readonly filePath: string,
    private readonly taskId: string,
    private readonly source: string,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
  }

  private poll(): void {
    if (!this.active) return;
    if (!existsSync(this.filePath)) return;

    const stat = statSync(this.filePath);
    if (stat.size <= this.offset) return;

    const stream = createReadStream(this.filePath, {
      start: this.offset,
      end: stat.size - 1,
    });
    const rl = createInterface({ input: stream });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;

        // Detect format: canonical (has 'type') vs youngflow (has 'event')
        let event: LiveLogEvent | null;
        if (raw.type) {
          // Canonical format (mock worker or already translated)
          event = raw as unknown as LiveLogEvent;
        } else if (raw.event) {
          // youngflow --json-log format, needs translation
          event = translateYoungflowEvent(raw, this.source);
        } else {
          return; // unrecognized
        }

        if (!event) return; // filtered out
        (event as LiveLogEvent & { source: string }).source =
          (event as LiveLogEvent & { source: string }).source ?? this.source;

        const entry = appendEvent(this.taskId, event);
        broadcastEvent(this.taskId, entry.seq, entry.event);
      } catch {
        logger.debug({ line }, "Failed to parse service event line");
      }
    });

    rl.on("close", () => {
      this.offset = stat.size;
    });
  }
}

/**
 * DirectoryTail: watches a directory for new *.service.jsonl files,
 * auto-creates FileTail for each discovered file.
 */
export class DirectoryTail {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = true;
  private knownFiles = new Set<string>();
  private fileTails: FileTail[] = [];

  constructor(
    private readonly dirPath: string,
    private readonly taskId: string,
    private readonly source: string,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    for (const ft of this.fileTails) ft.stop();
  }

  private scan(): void {
    if (!this.active) return;
    if (!existsSync(this.dirPath)) return;

    try {
      const files = readdirSync(this.dirPath).filter(
        (f) => f.endsWith(".service.jsonl"),
      );
      for (const file of files) {
        if (this.knownFiles.has(file)) continue;
        this.knownFiles.add(file);
        const fullPath = join(this.dirPath, file);
        const ft = new FileTail(fullPath, this.taskId, this.source);
        ft.start();
        this.fileTails.push(ft);
        logger.debug({ taskId: this.taskId, file }, "Auto-tailing new service event file");
      }
    } catch {
      // Directory may not exist yet
    }
  }
}

// Active tails per task
const activeTails = new Map<string, { files: FileTail[]; dirs: DirectoryTail[] }>();

export function startTailing(
  taskId: string,
  files: { path: string; source: string }[] = [],
  dirs: { path: string; source: string }[] = [],
): void {
  const entry = { files: [] as FileTail[], dirs: [] as DirectoryTail[] };
  for (const f of files) {
    const tail = new FileTail(f.path, taskId, f.source);
    tail.start();
    entry.files.push(tail);
  }
  for (const d of dirs) {
    const dt = new DirectoryTail(d.path, taskId, d.source);
    dt.start();
    entry.dirs.push(dt);
  }
  activeTails.set(taskId, entry);
  logger.info({ taskId, files: files.length, dirs: dirs.length }, "Started event tailing");
}

export function stopTailing(taskId: string): void {
  const entry = activeTails.get(taskId);
  if (entry) {
    for (const t of entry.files) t.stop();
    for (const d of entry.dirs) d.stop();
    activeTails.delete(taskId);
  }
}
