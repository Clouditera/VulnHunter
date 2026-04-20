import type { TaskState } from "../domain/task.js";
import type { Severity } from "../domain/severity.js";

export interface TaskSummary {
  id: string;
  tenant_id: string;
  project_name: string;
  state: TaskState;
  risk_score?: number;
  severity_counts: Record<Severity, number>;
  duration_ms?: number;
  created_at: string;
  started_at?: string;
  completed_at?: string;
}

export interface CreateTaskRequest {
  project_name: string;
  source: { type: "upload"; filename: string } | { type: "git"; url: string; branch?: string };
  auto_report_skill_ids?: string[];
}
