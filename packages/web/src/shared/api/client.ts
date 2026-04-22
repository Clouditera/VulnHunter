import type { SystemStatus } from "@vulnhunt/shared";

const BASE = "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = (body as { error?: { code?: string } })?.error?.code ?? "ERR_INTERNAL";
    const err = new Error(code);
    (err as Error & { code: string }).code = code;
    throw err;
  }

  return res.json() as Promise<T>;
}

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface TaskProfile {
  project_name?: string | null;
  language?: string | null;
  total_files?: number | null;
  total_loc?: number | null;
  build_system?: string | null;
}

export interface TaskExecution {
  model?: string | null;
  stages_completed?: number | null;
  total_tokens_in?: number | null;
  total_tokens_out?: number | null;
  tool_call_count?: number | null;
}

export interface TaskMetadata {
  profile?: TaskProfile;
  execution?: TaskExecution;
  [key: string]: unknown;
}

export interface Task {
  id: string;
  project_name: string;
  state: string;
  risk_score: number | null;
  failure_reason: string | null;
  source_type: string;
  duration_ms: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  tool_call_count: number;
  stage_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Populated by GET /api/tasks (list) — absent on single-task GET. */
  severity_counts?: SeverityCounts;
  metadata: TaskMetadata;
}

export interface FindingMeta {
  id: string;
  task_id: string;
  finding_key: string;
  severity: string;
  severity_numeric: number;
  vuln_type: string | null;
  vuln_type_full: string | null;
  primary_file: string | null;
  primary_line: number | null;
  function_name: string | null;
  user_verdict: string;
}

export const api = {
  system: {
    status: () => request<SystemStatus>("/api/system/status"),
    activate: (cert: string) => request<{ ok: boolean }>("/api/system/activate", {
      method: "POST",
      body: JSON.stringify({ cert }),
    }),
    bootstrap: (email: string, password: string) =>
      request<{ ok: boolean }>("/api/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
  },
  tasks: {
    list: (state?: string) =>
      request<{ tasks: Task[] }>(`/api/tasks${state ? `?state=${state}` : ""}`),
    get: (id: string) => request<{ task: Task }>(`/api/tasks/${id}`),
    create: (body: FormData | { git_url: string; project_name?: string }) =>
      body instanceof FormData
        ? fetch("/api/tasks", { method: "POST", credentials: "include", body }).then((r) => r.json() as Promise<{ task: Task }>)
        : request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
    cancel: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
    restart: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/restart`, { method: "POST" }),
    delete: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
    poc: (id: string) => request<{ poc_files: PocFile[] }>(`/api/tasks/${id}/poc`),
    pocContent: (id: string, filename: string, key: string) =>
      request<{ filename: string; content: string }>(`/api/tasks/${id}/poc/${filename}?key=${encodeURIComponent(key)}`),
    workspaceTree: (id: string) =>
      request<{ tree: WorkspaceTreeNode[] }>(`/api/tasks/${id}/workspace/tree`),
    workspaceFile: (id: string, path: string, line?: number) =>
      request<WorkspaceFile>(
        `/api/tasks/${id}/workspace/file?path=${encodeURIComponent(path)}${
          line ? `&line=${line}` : ""
        }`,
      ),
  },
  findings: {
    list: (taskId: string, severity?: string) =>
      request<{ findings: FindingMeta[] }>(`/api/tasks/${taskId}/findings${severity ? `?severity=${severity}` : ""}`),
  },
  auth: {
    login: (email: string, password: string) =>
      request<{ ok: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  },
  settings: {
    getCredential: () => request<{ credential: LlmCredential | null }>("/api/settings/credential"),
    saveCredential: (cred: SaveCredentialPayload) =>
      request<{ id: string }>("/api/settings/credential", {
        method: "PUT",
        body: JSON.stringify(cred),
      }),
    getSystemConfig: () => request<{ config: SystemConfig }>("/api/settings/system"),
    updateSystemConfig: (patch: Partial<SystemConfig>) =>
      request<{ ok: boolean }>("/api/settings/system", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    listModels: () =>
      request<{ models: Array<{ id: string; owned_by?: string }>; error?: string }>("/api/settings/models"),
    testModel: (params: { proto_type: string; base_url?: string; model_id: string; api_key: string }) =>
      request<{ ok: boolean; message?: string; error?: string }>("/api/settings/credential/test", {
        method: "POST",
        body: JSON.stringify(params),
      }),
  },
  chat: {
    listSessions: () => request<{ sessions: ChatSession[] }>("/api/chat/sessions"),
    createSession: (name?: string) =>
      request<{ session: ChatSession }>("/api/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    getSession: (id: string) => request<{ session: ChatSession }>(`/api/chat/sessions/${id}`),
    deleteSession: (id: string) => request<{ ok: boolean }>(`/api/chat/sessions/${id}`, { method: "DELETE" }),
    listMessages: (sessionId: string, sinceSeq?: number) =>
      request<{ messages: ChatMessage[] }>(
        `/api/chat/sessions/${sessionId}/messages${sinceSeq != null ? `?since_seq=${sinceSeq}` : ""}`
      ),
    sendPrompt: (sessionId: string, message: string) =>
      request<{ ok: boolean }>(`/api/chat/sessions/${sessionId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ message }),
      }),
    abort: (sessionId: string) =>
      request<{ ok: boolean }>(`/api/chat/sessions/${sessionId}/abort`, { method: "POST" }),
  },
  dashboard: {
    get: (range?: string) =>
      request<DashboardData>(`/api/dashboard${range ? `?range=${range}` : ""}`),
  },
};

export interface LlmCredential {
  id: string;
  provider: string;
  proto_type: string;
  base_url: string | null;
  model_id: string;
  thinking_effort: string;
  label: string;
  is_default: boolean;
}

export interface SaveCredentialPayload {
  provider: string;
  proto_type: string;
  base_url?: string;
  model_id: string;
  thinking_effort?: string;
  label?: string;
  api_key: string;
}

export interface SystemConfig {
  max_parallel_scan: number;
  max_parallel_chat: number;
  max_parallel_report: number;
  scan_cpu_limit: number;
  scan_memory_gb: number;
  chat_cpu_limit: number;
  chat_memory_gb: number;
  report_cpu_limit: number;
  report_memory_gb: number;
  upload_zip_max_mb: number;
  git_repo_max_mb: number;
  live_log_buffer_cap: number;
  chat_idle_timeout_min: number;
  worker_spawn_timeout_sec: number;
}

export interface ChatSession {
  id: string;
  name: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  seq: number;
  tool_calls?: Array<{ tool: string; args: string; result?: string }>;
  created_at: string;
}

export interface PocFile {
  key: string;
  name: string;
  size: number;
}

export interface WorkspaceTreeNode {
  name: string;
  type: "file" | "dir";
  /** Children present ⇒ this node is effectively a directory, even if backend
      labelled it 'file' (buildTree has a known quirk with same-named entries). */
  children?: WorkspaceTreeNode[];
  /** Populated client-side: set to true when any finding's primary_file falls
      under this node's subtree. Not returned by backend. */
  hasVuln?: boolean;
}

export interface WorkspaceVulnDecoration {
  line: number;
  finding_key: string;
  severity: string;
  message: string;
}

export interface WorkspaceFile {
  content: string;
  language: string;
  total_lines: number;
  size_bytes: number;
  is_truncated: boolean;
  type: "text" | "binary" | "image";
  vuln_decorations?: WorkspaceVulnDecoration[];
  requested_line?: number;
}

export interface DashboardData {
  range: string;
  stats: {
    total_scans: { value: number; delta: string };
    vulnerabilities: { value: number; delta: string };
    avg_duration_min: { value: number; delta: string };
    total_tokens_m?: { value: number; delta: string };
  };
  severity_dist: Record<string, number>;
  cwe_top5: Array<{ cwe: string; count: number }>;
  recent_scans: Task[];
}
