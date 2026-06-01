/**
 * Per-task in-memory ring buffer for live log events.
 * Capacity: 1000 events per task (configurable).
 * Seq numbers are monotonically increasing per task.
 */

import type { LiveLogEvent } from "@vulnagent/shared";

interface EventEntry {
  seq: number;
  event: LiveLogEvent;
}

class RingBuffer {
  private buffer: EventEntry[] = [];
  private nextSeq = 0;
  private cap: number;

  constructor(cap = 1000) {
    this.cap = cap;
  }

  append(event: LiveLogEvent): EventEntry {
    const seq = this.nextSeq++;
    const entry: EventEntry = { seq, event: { ...event, seq } as LiveLogEvent };
    if (this.buffer.length >= this.cap) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
    return entry;
  }

  getSince(sinceSeq: number): EventEntry[] {
    return this.buffer.filter((e) => e.seq > sinceSeq);
  }

  getAll(): EventEntry[] {
    return [...this.buffer];
  }

  get currentSeq(): number {
    return this.nextSeq - 1;
  }
}

// Global event store: taskId → RingBuffer
const taskBuffers = new Map<string, RingBuffer>();

export function getOrCreateBuffer(taskId: string, cap = 1000): RingBuffer {
  let buf = taskBuffers.get(taskId);
  if (!buf) {
    buf = new RingBuffer(cap);
    taskBuffers.set(taskId, buf);
  }
  return buf;
}

export function appendEvent(taskId: string, event: LiveLogEvent): EventEntry {
  const buf = getOrCreateBuffer(taskId);
  return buf.append(event);
}

export function getEventsSince(taskId: string, sinceSeq: number): EventEntry[] {
  return taskBuffers.get(taskId)?.getSince(sinceSeq) ?? [];
}

export function getAllEvents(taskId: string): EventEntry[] {
  return taskBuffers.get(taskId)?.getAll() ?? [];
}

export function clearTaskBuffer(taskId: string): void {
  taskBuffers.delete(taskId);
}
