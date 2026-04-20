/** Canonical service-event schema — produced by youngflow (--emit-service-events) and worker-bridge */

export type LiveLogEventType =
  | "tool_call"
  | "stage_start"
  | "stage_end"
  | "task_status"
  | "source_lifecycle"
  | "error";

export type TaskStatus = "running" | "completed" | "failed" | "cancelled" | "paused";

export interface ToolCallEvent {
  type: "tool_call";
  source: string; // "scan" | "report:<skill-id>" | "chat"
  seq: number;
  ts: string;
  stage: string;
  tool: string;
  args_summary: string;
  duration_ms: number;
  status: "success" | "error";
  error_summary?: string;
}

export interface StageStartEvent {
  type: "stage_start";
  source: string;
  seq: number;
  ts: string;
  stage: string;
}

export interface StageEndEvent {
  type: "stage_end";
  source: string;
  seq: number;
  ts: string;
  stage: string;
  duration_ms: number;
  turns: number;
  tokens_in?: number;
  tokens_out?: number;
  status: "success" | "error";
}

export interface TaskStatusEvent {
  type: "task_status";
  source: string;
  seq: number;
  ts: string;
  status: TaskStatus;
  reason?: string;
}

export interface SourceLifecycleEvent {
  type: "source_lifecycle";
  source: string;
  seq: number;
  ts: string;
  state: "started" | "completed" | "failed";
}

export interface ErrorEvent {
  type: "error";
  source: string;
  seq: number;
  ts: string;
  stage?: string;
  code: string;
  summary: string;
  retries?: number;
}

export type LiveLogEvent =
  | ToolCallEvent
  | StageStartEvent
  | StageEndEvent
  | TaskStatusEvent
  | SourceLifecycleEvent
  | ErrorEvent;

/** WS subscribe message (client → server) */
export interface LiveLogSubscribe {
  type: "subscribe";
  task_id: string;
  since_seq?: number;
  source_filter?: string[];
}

/** WS snapshot_end message */
export interface SnapshotEndEvent {
  type: "snapshot_end";
  next_seq: number;
}

/** WS ping */
export interface PingEvent {
  type: "ping";
}
