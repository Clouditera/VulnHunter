export type TaskState =
  | "queued"
  | "preparing"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
