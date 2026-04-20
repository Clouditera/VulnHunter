/**
 * EventTail: tails a .service.jsonl file from a worker volume,
 * parses lines as LiveLogEvent, appends to the task ring buffer.
 *
 * youngflow writes: <output_dir>/.youngflow/logs/<stage>.service.jsonl
 * bridge writes:    /workspace/.report/events.jsonl (chat/report workers)
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { logger } from "../../infra/logger.js";
import { appendEvent } from "./event-store.js";
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
        appendEvent(this.taskId, event);
      } catch {
        logger.debug({ line }, "Failed to parse service event line");
      }
    });

    rl.on("close", () => {
      this.offset = stat.size;
    });
  }
}

// Active tails per task: taskId → FileTail[]
const activeTails = new Map<string, FileTail[]>();

export function startTailing(taskId: string, files: { path: string; source: string }[]): void {
  const tails: FileTail[] = [];
  for (const f of files) {
    const tail = new FileTail(f.path, taskId, f.source);
    tail.start();
    tails.push(tail);
  }
  activeTails.set(taskId, tails);
  logger.info({ taskId, files: files.length }, "Started event tailing");
}

export function stopTailing(taskId: string): void {
  const tails = activeTails.get(taskId);
  if (tails) {
    for (const t of tails) t.stop();
    activeTails.delete(taskId);
  }
}
