/**
 * Event Archive — loads task events from MinIO archive + in-memory + local fallback.
 * Used by REST API (/api/tasks/:id/events) and MCP tools (get-task-events).
 */
import { getAllEvents } from "./event-store.js";
import { translateYoungflowEvent } from "./event-tail.js";
import { getMinio } from "../../infra/minio/client.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import type { LiveLogEvent } from "@vulnagent/shared";

export interface EventEntry {
  seq: number;
  event: LiveLogEvent;
}

export async function loadTaskEvents(params: {
  taskId: string;
  taskState: string;
  source?: string;
  limit?: number;
}): Promise<EventEntry[]> {
  const { taskId, taskState, source, limit } = params;

  // In-memory events (from active tailing)
  const memEvents = getAllEvents(taskId) as EventEntry[];

  // For running/paused tasks with in-memory events, return those directly
  if (memEvents.length > 0 && ["running", "paused"].includes(taskState)) {
    return applyFilters(memEvents, source, limit);
  }

  // Read archived events from MinIO + merge with in-memory
  const config = loadConfig();
  const minio = getMinio();
  const prefix = `scan-outputs/${taskId}/.youngflow/logs/`;

  try {
    const keys: string[] = [];
    const stream = minio.listObjects(config.minio.bucket, prefix, true);
    for await (const obj of stream) {
      if (obj.name?.endsWith(".service.jsonl") || obj.name?.endsWith("youngflow.service.jsonl")) {
        keys.push(obj.name);
      }
    }

    if (keys.length === 0) {
      // Fallback: read from local workspace
      const localEvents = await loadLocalEvents(taskId, config.dataDir);
      if (localEvents.length > 0) {
        return applyFilters(localEvents, source, limit);
      }
      return applyFilters(memEvents, source, limit);
    }

    const events: EventEntry[] = [];
    let seq = 0;

    for (const key of keys) {
      try {
        const objStream = await minio.getObject(config.minio.bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of objStream) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf-8");

        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);
            if (!raw.event) continue;
            const translated = translateYoungflowEvent(raw, "scan");
            if (translated) {
              seq++;
              translated.seq = seq;
              events.push({ seq, event: translated });
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    const allEvents = orderEventsForDisplay([...events, ...memEvents], taskState);
    return applyFilters(allEvents, source, limit);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to load archived events");
    return applyFilters(memEvents, source, limit);
  }
}

async function loadLocalEvents(taskId: string, dataDir: string): Promise<EventEntry[]> {
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const localLogsDir = join(dataDir, "workspaces", taskId, "out", ".youngflow", "logs");

  if (!existsSync(localLogsDir)) return [];

  const localFiles = readdirSync(localLogsDir).filter((f) => f.endsWith(".service.jsonl"));
  const events: EventEntry[] = [];
  let seq = 0;

  for (const file of localFiles) {
    try {
      const text = readFileSync(join(localLogsDir, file), "utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const raw = JSON.parse(line);
          if (!raw.event) continue;
          const translated = translateYoungflowEvent(raw, "scan");
          if (translated) {
            seq++;
            translated.seq = seq;
            events.push({ seq, event: translated });
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return orderEventsForDisplay(events, "completed");
}

function orderEventsForDisplay(events: EventEntry[], taskState: string): EventEntry[] {
  const ordered = [...events].sort((a, b) => {
    const at = Date.parse(a.event.ts ?? "");
    const bt = Date.parse(b.event.ts ?? "");
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    return a.seq - b.seq;
  });

  // Terminal tasks should surface the final task_status as the effective tail.
  // In-memory events can be merged after archive events and otherwise hide the
  // YoungFlow flow_end translation from the collapsed LiveLog summary.
  if (["completed", "failed", "cancelled"].includes(taskState)) {
    let idx = -1;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const entry = ordered[i];
      if (
        entry.event.type === "task_status" &&
        ["completed", "failed", "cancelled"].includes(String((entry.event as any).status ?? (entry.event as any).state ?? ""))
      ) {
        idx = i;
        break;
      }
    }
    if (idx >= 0 && idx !== ordered.length - 1) {
      const [terminal] = ordered.splice(idx, 1);
      ordered.push(terminal);
    }
  }

  return ordered.map((entry, index) => ({
    seq: index + 1,
    event: { ...entry.event, seq: index + 1 },
  }));
}

function applyFilters(events: EventEntry[], source?: string, limit?: number): EventEntry[] {
  let filtered = events;
  if (source && source !== "all") {
    filtered = filtered.filter((e) => (e.event as any).source === source);
  }
  if (limit) {
    filtered = filtered.slice(-limit);
  }
  return filtered;
}
