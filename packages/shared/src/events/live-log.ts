/** Canonical service-event schema — produced by youngflow (--emit-service-events) and worker-bridge */

export type LiveLogEventType =
  | "tool_call"
  | "stage_start"
  | "stage_end"
  | "task_status"
  | "source_lifecycle"
  | "error"
  | "poc_output"
  | "poc_exit";

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
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  status: "success" | "error";
}

export interface TaskStatusEvent {
  type: "task_status";
  source: string;
  seq: number;
  ts: string;
  status: TaskStatus;
  reason?: string;
  severity?: "info" | "warning" | "error";
  stages_total?: number;
  stages_completed?: number;
  stages_failed?: number;
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

export interface PocOutputEvent {
  type: "poc_output";
  source: string;
  seq: number;
  ts: string;
  stage: string;
  stream: "stdout" | "stderr";
  message: string;
  finding_key?: string;
  run_id?: string;
  job_id?: string;
}

export interface PocExitEvent {
  type: "poc_exit";
  source: string;
  seq: number;
  ts: string;
  stage: string;
  exit_code: number;
  duration_ms: number;
  finding_key?: string;
  run_id?: string;
  job_id?: string;
}

/**
 * Prepare-phase lifecycle events (H5 §8) — emitted by the Scheduler owner as it
 * runs the Prepare worker and consumes its three-field result, so the task
 * detail event card can surface Prepare progress alongside scan progress.
 * `source` is "scan" so it renders in the existing scan stream.
 */
export interface PrepareEvent {
  type: "prepare_started" | "prepare_completed" | "prepare_failed";
  source: string;
  seq: number;
  ts: string;
  /** present on prepare_started */
  dynamic_enabled?: boolean;
  /** present on prepare_completed */
  project_complete?: boolean;
  sandbox_type?: string | null;
  reason?: string;
  /** present on prepare_failed (O1 remediation hint) */
  remediation?: string;
  /**
   * continue mode reused first-run prepare (task-c832309f / fish 2026-08-08).
   * true when no prepare worker was spawned and metadata.prepare was reused.
   */
  reused?: boolean;
}

/**
 * Sandbox allocation terminal failure (H2 §3): emitted once when the bounded
 * quota/capacity retry budget is exhausted and the task fails with the O1
 * user-visible reason. Transient requeues are log-only.
 */
export interface SandboxAllocFailedEvent {
  type: "sandbox_alloc_failed";
  source: string;
  seq: number;
  ts: string;
  /** "quota" (per-user limit) | "capacity" (SandboxPlane admission) */
  reason: string;
  attempts: number;
  remediation: string;
}

export type LiveLogEvent =
  | ToolCallEvent
  | StageStartEvent
  | StageEndEvent
  | TaskStatusEvent
  | SourceLifecycleEvent
  | ErrorEvent
  | PocOutputEvent
  | PocExitEvent
  | PrepareEvent
  | SandboxAllocFailedEvent;

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
