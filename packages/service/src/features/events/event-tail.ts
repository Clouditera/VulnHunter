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
        const event = JSON.parse(line) as LiveLogEvent;
        // Inject source if not already set
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
