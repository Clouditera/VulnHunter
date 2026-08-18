/**
 * Event helpers shared by the scheduler and the internal prepare-result
 * callback route (both append + broadcast task-scoped completion events
 * while holding / validating the same scheduler claim).
 */

import { appendEvent } from "../events/event-store.js";
import { broadcastEvent } from "../events/ws-live-log.js";
import type { LiveLogEvent } from "@vulnhunter/shared";

export function appendAndBroadcastCompletionEvent(taskId: string, event: LiveLogEvent): void {
  const entry = appendEvent(taskId, event);
  broadcastEvent(taskId, entry.seq, entry.event);
}
