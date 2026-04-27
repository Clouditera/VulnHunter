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
  /**
   * Human-readable credential label (e.g. "Mimo V2 Pro — mimo-v2-pro").
   * Populated on GET /api/tasks/:id. May be null if the credential was
   * deleted after the task was created.
   */
  credential_label?: string | null;
  credential_id?: string | null;
  /**
   * Source archive metadata. For uploads: `{ filename, minio_key, size_bytes? }`.
   * For git clones: `{ git_url, git_branch?, minio_key? }`.
   */
  source_meta?: {
    filename?: string;
    minio_key?: string;
    size_bytes?: number;
    git_url?: string;
    git_branch?: string;
    [key: string]: unknown;
  } | null;
}

/**
 * Finding detail — schema is deliberately loose because youngflow emits
 * a simpler YAML shape than `bug-report.schema.yaml`.
 *
 * Real shape observed from the scanner:
 *   vulnerability: { vuln_type, severity, file_path, function, line,
 *                    language, source, sink }
 *   metadata: { group_id, attack_surface, discovered_by, confidence,
 *               composite_score, risk_level }
 *   description / code / data_flow / attack / remediation: plain strings
 *   references: Array<{ [label: string]: string }>
 *
 * The spec shape (structured objects) also still appears in some cases.
 * Renderers must handle both.
 */
export type FindingDetailSection = string | Record<string, unknown> | null | undefined;
export interface FindingDetail {
  vulnerability?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  description?: FindingDetailSection;
  code?: FindingDetailSection;
  data_flow?: FindingDetailSection;
  attack?: FindingDetailSection;
  remediation?: FindingDetailSection;
  references?: Array<string | Record<string, unknown>>;
  related?: Array<Record<string, unknown>>;
  [key: string]: unknown;
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
    create: (
      body:
        | FormData
        | { git_url: string; project_name?: string; credential_id?: string },
    ) =>
      body instanceof FormData
        ? fetch("/api/tasks", { method: "POST", credentials: "include", body }).then((r) => r.json() as Promise<{ task: Task }>)
        : request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
    /**
     * Upload a FormData body with progress events.
     * Used by NewTaskModal so the user can see upload %.
     * fetch() does not expose upload progress — XHR is required.
     */
    createWithProgress: (
      body: FormData,
      onProgress: (pct: number) => void,
    ): Promise<{ task: Task }> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/tasks");
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch (err) {
              reject(err);
            }
          } else {
            let msg = `HTTP ${xhr.status}`;
            try {
              const parsed = JSON.parse(xhr.responseText);
              msg = parsed?.error?.message ?? parsed?.error?.code ?? msg;
            } catch {}
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.onabort = () => reject(new Error("Upload aborted"));
        xhr.send(body);
      }),
    update: (id: string, body: { credential_id?: string | null }) =>
      request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    cancel: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
    pause: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/pause`, { method: "POST" }),
    resume: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/resume`, { method: "POST" }),
    restart: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/restart`, { method: "POST" }),
    delete: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
    poc: (id: string) => request<{ poc_files: PocFile[] }>(`/api/tasks/${id}/poc`),
    pocContent: (id: string, filename: string, key: string) =>
      request<{ filename: string; content: string }>(`/api/tasks/${id}/poc/${filename}?key=${encodeURIComponent(key)}`),
    pocSummary: (id: string) => request<PocSummary>(`/api/tasks/${id}/poc`),
    pocGenerate: (id: string, opts: {
      finding_keys: string[];
      target_mode: string;
      target_url?: string;
      custom_instructions?: string;
      browser_tool?: string;
      deveye_server?: string;
      deveye_token?: string;
    }) => request<{ job: PocJob }>(`/api/tasks/${id}/poc/generate`, {
      method: "POST",
      body: JSON.stringify(opts),
    }),
    pocFindingDetail: (id: string, findingKey: string) =>
      request<{ result: PocResult; runs: PocRun[] }>(`/api/tasks/${id}/poc/${findingKey}`),
    pocScript: (id: string, findingKey: string) =>
      fetch(`/api/tasks/${id}/poc/${findingKey}/script`, { credentials: "include" }).then((r) => r.text()),
    pocLog: (id: string, findingKey: string) =>
      fetch(`/api/tasks/${id}/poc/${findingKey}/log`, { credentials: "include" }).then((r) => r.text()),
    pocRun: (id: string, findingKey: string, opts?: {
      target_url?: string;
      custom_instructions?: string;
    }) => request<{ run: PocRun }>(`/api/tasks/${id}/poc/${findingKey}/run`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    }),
    workspaceTree: (id: string) =>
      request<{ tree: WorkspaceTreeNode[] }>(`/api/tasks/${id}/workspace/tree`),
    workspaceFile: (id: string, path: string, line?: number) =>
      request<WorkspaceFile>(
        `/api/tasks/${id}/workspace/file?path=${encodeURIComponent(path)}${
          line ? `&line=${line}` : ""
        }`,
      ),
    /** Wiki payload: project profile + aggregated analysis docs + feature
     *  cards. Backend assembles from `scan-outputs/<tid>/` MinIO files.
     *  Any field may be null if the corresponding file is missing (e.g. a
     *  task that didn't run all stages). */
    wiki: (id: string) =>
      request<WikiPayload>(`/api/tasks/${id}/wiki`),
    /** Historical events for a finished task. Backend prefers the in-memory
     *  ring buffer when present (running tasks), falling back to MinIO
     *  archive `scan-outputs/<id>/.youngflow/logs/youngflow.service.jsonl`
     *  for terminal tasks. Returns canonical translated events ready for
     *  the LiveLog renderer. */
    events: (id: string) =>
      request<{ events: Array<Record<string, unknown>> }>(
        `/api/tasks/${id}/events`,
      ),
  },
  findings: {
    list: (taskId: string, severity?: string) =>
      request<{ findings: FindingMeta[] }>(`/api/tasks/${taskId}/findings${severity ? `?severity=${severity}` : ""}`),
    detail: (taskId: string, key: string) =>
      request<{ meta: FindingMeta; detail: FindingDetail }>(
        `/api/tasks/${taskId}/findings/${encodeURIComponent(key)}`,
      ),
  },
  settings: {
    getCredential: () => request<{ credential: LlmCredential | null }>("/api/settings/credential"),
    /** List all credentials (multi-credential support). */
    listCredentials: () =>
      request<{ credentials: LlmCredential[] }>("/api/settings/credentials"),
    /** Delete a credential by id. */
    deleteCredential: (id: string) =>
      request<{ ok: boolean }>(`/api/settings/credentials/${id}`, {
        method: "DELETE",
      }),
    /** Set a credential as the default. */
    setDefaultCredential: (id: string) =>
      request<{ ok: boolean }>(`/api/settings/credentials/${id}/default`, {
        method: "POST",
      }),
    saveCredential: (cred: SaveCredentialPayload) =>
      request<{ id: string }>("/api/settings/credential", {
        method: "PUT",
        body: JSON.stringify(cred),
      }),
    /** Update credential metadata without re-entering API key */
    patchCredential: (id: string, meta: { provider?: string; proto_type?: string; base_url?: string; model_id?: string; thinking_effort?: string; label?: string }) =>
      request<{ ok: boolean }>(`/api/settings/credential/${id}`, {
        method: "PATCH",
        body: JSON.stringify(meta),
      }),
    getSystemConfig: () => request<{ config: SystemConfig }>("/api/settings/system"),
    updateSystemConfig: (patch: Partial<SystemConfig>) =>
      request<{ ok: boolean }>("/api/settings/system", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    listModels: (params?: { base_url?: string; api_key?: string; proto_type?: string }) =>
      request<{ models: Array<{ id: string; owned_by?: string }>; error?: string }>(
        "/api/settings/models",
        { method: "POST", body: JSON.stringify(params ?? {}) },
      ),
    /**
     * Test connection.
     *  - Pass `credential_id` to test against a stored credential using
     *    the already-saved API key (backend decrypts it). Use this when
     *    editing a credential the user hasn't typed the key for again.
     *  - Pass `proto_type/base_url/model_id/api_key` explicitly for a
     *    brand-new draft credential before it's saved.
     */
    testModel: (
      params:
        | { credential_id: string }
        | {
            proto_type: string;
            base_url?: string;
            model_id: string;
            api_key: string;
          },
    ) =>
      request<{ ok: boolean; message?: string; error?: string }>("/api/settings/credential/test", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    getPocSettings: () =>
      request<{ settings: PocSettingsApi }>("/api/settings/poc"),
    updatePocSettings: (body: Partial<PocSettingsApi>) =>
      request<{ settings: PocSettingsApi }>("/api/settings/poc", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    testPocConnection: (body?: { server_url?: string; token?: string }) =>
      request<{ ok: boolean; server_version?: string; error?: string }>(
        "/api/settings/poc/test",
        { method: "POST", body: JSON.stringify(body ?? {}) },
      ),
  },
  users: {
    list: () => request<{ users: UserApi[] }>("/api/users"),
    create: (data: { email: string; password: string; display_name?: string; role?: string; must_change_password?: boolean }) =>
      request<{ user: UserApi }>("/api/users", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: { display_name?: string; role?: string; status?: string; reset_password?: string }) =>
      request<{ ok: boolean }>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/users/${id}`, { method: "DELETE" }),
  },
  auth: {
    login: (email: string, password: string) =>
      request<{ ok: boolean; user: { id: string; email: string; displayName: string; role: string; mustChangePassword: boolean } }>(
        "/api/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      ),
    logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
    changePassword: (old_password: string, new_password: string) =>
      request<{ ok: boolean }>("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ old_password, new_password }),
      }),
    forceChangePassword: (new_password: string) =>
      request<{ ok: boolean }>("/api/auth/force-change-password", {
        method: "POST",
        body: JSON.stringify({ new_password }),
      }),
    updateMe: (data: { display_name?: string }) =>
      request<{ ok: boolean }>("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  },
  dashboard: {
    get: (range?: string) =>
      request<DashboardData>(`/api/dashboard${range ? `?range=${range}` : ""}`),
  },
  chat: {
    sessions: {
      list: () =>
        request<{ sessions: ChatSessionApi[] }>("/api/chat/sessions"),
      create: (title?: string) =>
        request<{ session: ChatSessionApi }>("/api/chat/sessions", {
          method: "POST",
          body: JSON.stringify(title ? { title } : {}),
        }),
      get: (id: string) =>
        request<{ session: ChatSessionApi }>(`/api/chat/sessions/${id}`),
      delete: (id: string) =>
        request<{ ok: boolean }>(`/api/chat/sessions/${id}`, { method: "DELETE" }),
      messages: (id: string) =>
        request<{ messages: ChatMessageApi[] }>(
          `/api/chat/sessions/${id}/messages`,
        ),
      prompt: (id: string, message: string) =>
        request<{ ok: boolean }>(`/api/chat/sessions/${id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ message }),
        }),
      /**
       * Upload a file attachment. Server stores it under the session's
       * attachments directory and returns `{ path, originalFilename }`.
       * The path is container-local (`/workspace/chat-session/...`) so
       * pi's `read` tool can open it directly.
       */
      upload: (id: string, file: File) => {
        const fd = new FormData();
        fd.append("file", file);
        return fetch(`/api/chat/sessions/${id}/upload`, {
          method: "POST",
          credentials: "include",
          body: fd,
        }).then(async (r) => {
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            throw new Error(text || `upload failed (${r.status})`);
          }
          return r.json() as Promise<{
            path: string;
            originalName: string;
          }>;
        });
      },
      abort: (id: string) =>
        request<{ ok: boolean }>(`/api/chat/sessions/${id}/abort`, {
          method: "POST",
        }),
      /** Switch the model for a running session. The bridge sends pi
       *  `set_model` to the already-running worker, and updates DB for
       *  future container spawns. */
      setModel: (id: string, credentialId: string) =>
        request<{ ok: boolean }>(`/api/chat/sessions/${id}/set-model`, {
          method: "POST",
          body: JSON.stringify({ credential_id: credentialId }),
        }),
    },
  },
  skills: {
    list: () => request<{ skills: ReportSkill[] }>("/api/settings/skills"),
    /** Upload a skill .zip via multipart/form-data. Field name must be `file`. */
    upload: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch("/api/settings/skills", {
        method: "POST",
        credentials: "include",
        body: fd,
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.text()) || "upload failed");
        return r.json() as Promise<{ skill: ReportSkill }>;
      });
    },
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/settings/skills/${id}`, { method: "DELETE" }),
  },
  reports: {
    list: (taskId: string) =>
      request<{ reports: UserReport[] }>(`/api/tasks/${taskId}/reports`),
    get: (taskId: string, reportId: string) =>
      request<{ report: UserReport }>(
        `/api/tasks/${taskId}/reports/${reportId}`,
      ),
    generate: (
      taskId: string,
      body: { skill_id: string; credential_id?: string },
    ) =>
      request<{ report: UserReport }>(
        `/api/tasks/${taskId}/reports/generate`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    delete: (taskId: string, reportId: string) =>
      request<{ ok: boolean }>(`/api/tasks/${taskId}/reports/${reportId}`, {
        method: "DELETE",
      }),
    /** URL for preview/download; use directly as <iframe src> or anchor href. */
    fileUrl: (taskId: string, reportId: string) =>
      `/api/tasks/${taskId}/reports/${reportId}/file`,
    downloadUrl: (taskId: string, reportId: string) =>
      `/api/tasks/${taskId}/reports/${reportId}/download`,
  },
};

export interface ReportSkill {
  id: string;
  name: string;
  description: string | null;
  size_bytes: number;
  attachment_count: number;
  created_at: string;
}

export interface UserReport {
  id: string;
  task_id: string;
  skill_id: string;
  skill_name?: string;
  status: "generating" | "completed" | "failed";
  format?: string | null;
  primary_file?: string | null;
  created_at: string;
  completed_at?: string | null;
  duration_ms?: number | null;
  failure_reason?: string | null;
}

export interface LlmCredential {
  id: string;
  provider: string;
  proto_type: string;
  base_url: string | null;
  model_id: string;
  thinking_effort: string;
  label: string;
  is_default: boolean;
  /**
   * Masked API key for display, e.g. "sk-c••••593f". Present on
   * listCredentials / getCredential responses; never on write payloads.
   */
  masked_key?: string;
}

export interface SaveCredentialPayload {
  /** Optional credential id. Present = update, absent = create. */
  id?: string;
  provider: string;
  proto_type: string;
  base_url?: string;
  model_id: string;
  thinking_effort?: string;
  label?: string;
  api_key: string;
  is_default?: boolean;
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

export interface PocJob {
  id: string;
  task_id: string;
  state: string;
  target_mode: string;
  target_url: string | null;
  custom_instructions: string | null;
  browser_tool: string;
  finding_keys: string[];
  failure_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface PocResult {
  id: string;
  task_id: string;
  job_id: string;
  finding_key: string;
  status: string;
  poc_script_minio_key: string | null;
  result_json_minio_key: string | null;
  run_log_minio_key: string | null;
  screenshots_prefix: string | null;
  target_url: string | null;
  exit_code: number | null;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface PocRun {
  id: string;
  task_id: string;
  finding_key: string;
  state: string;
  target_url: string | null;
  exit_code: number | null;
  run_log_minio_key: string | null;
  events_minio_key: string | null;
  failure_reason: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  duration_ms: number | null;
}

export interface UserApi {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface PocSettingsApi {
  default_target_mode: string;
  default_browser_tool: string;
  deveye_server_url: string | null;
  deveye_token: string | null;
  default_concurrency: number;
  poc_timeout_s: number;
  container_network_mode: string;
}

export interface PocSummary {
  results: PocResult[];
  latest_job: PocJob | null;
  summary: {
    total: number;
    reproduced: number;
    partial: number;
    not_reproduced: number;
    error: number;
    skipped: number;
    pending: number;
  };
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

/* -------------------------------------------------------------------------- */
/*  Wiki Tab                                                                  */
/* -------------------------------------------------------------------------- */

/** Risk level flag from feature cards. */
export type WikiRiskLevel = "low" | "medium" | "high" | "critical" | string;

/** Per-type project classification node from profiler.project_type. */
export interface WikiProjectTypeFlag {
  is_type: boolean;
  reason?: string | null;
}

/** Parsed profiler YAML. Mirrors youngflow's nested structure verbatim —
 *  the renderer flattens / formats; the wire shape stays close to source
 *  so we can add fields without backend changes. */
export interface WikiProfiler {
  is_valid_scan_target?: boolean | null;
  classification_basis?: string | null;
  potential_risks?: string | null;
  basic_info?: {
    project_name?: string | null;
    project_root?: string | null;
  };
  project_type?: Record<string, WikiProjectTypeFlag>;
  tech_stack?: {
    language?: string | null;
    framework?: string | null;
    package_manager?: string | null;
  };
  code_stats?: {
    file_count?: number | null;
    loc?: number | null;
    structure?: string[] | null;
  };
  test_dirs?: string[];
  entry_points?: {
    main_files?: string[];
    route_files?: string[];
  };
  route_snippets?: string | null;
  attack_surface?: {
    high_value_targets?: string | null;
    potential_entry_points?: string | null;
  };
}

/** A Markdown document rendered inline. */
export interface WikiReport {
  name: string;
  format: "md";
  content: string;
}

/** Backend wraps each feature in `{feature: {...}}`; keep that envelope. */
export interface WikiFeatureEnvelope {
  feature: WikiFeature;
}

export interface WikiFeature {
  id: string;
  name: string;
  description?: string | null;
  perspective?: string | null;
  risk_level?: WikiRiskLevel | null;
  risk_rationale?: string | null;
  language?: string | null;
  entry_points?: Array<{ type?: string; file: string; line?: number }>;
  data_flow?: {
    input_format?: string;
    output_format?: string;
    processing_chain?: Array<{
      step?: number;
      action: string;
      file?: string;
      line?: number;
      function?: string;
    }>;
    secondary_parsing?: boolean;
    secondary_format?: string;
  };
  security?: { auth_required?: boolean };
  code_locations?: Array<{
    file: string;
    start_line?: number;
    end_line?: number;
    code_type?: string;
  }>;
  related_features?: string[];
  discovered_by?: string;
  confidence?: string;
  perspectives?: string[];
  composite_score?: number;
}

export interface WikiFeatureGroupEnvelope {
  group: WikiFeatureGroup;
}

export interface WikiFeatureGroup {
  id: string;
  name: string;
  attack_surface?: string | null;
  feature_ids: string[];
  context_feature_ids?: string[];
  shared_code_paths?: Array<{
    file: string;
    functions?: string[];
  }>;
}

/** Deep analysis summary per group (`analysis_summaries/<group>.yaml`). */
export interface WikiAnalysisSummary {
  group_id: string;
  attack_surface?: string | null;
  files_read?: Array<{ file: string; lines_read?: string }>;
  covered_sinks?: Array<{
    file: string;
    line: number;
    function?: string;
    sink?: string;
    vuln_type?: string;
  }>;
  /** Anything else (changes shape across versions). */
  [key: string]: unknown;
}

export interface WikiPayload {
  profiler: WikiProfiler | null;
  reports: WikiReport[];
  features: WikiFeatureEnvelope[];
  featureGroups: WikiFeatureGroupEnvelope[];
  analysisSummaries: WikiAnalysisSummary[];
}

/* -------------------------------------------------------------------------- */
/*  Chat API shapes (matches the contract Developer confirmed for 6B)        */
/* -------------------------------------------------------------------------- */

export interface ChatSessionApi {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  preview?: string | null;
  worker_state?: "idle" | "running" | "spawning";
  /** Id of the LLM credential this session is bound to. `null` means the
   *  system default is used at spawn time. Backend returns this on
   *  `/api/chat/sessions` list and `/api/chat/sessions/:id`. */
  credential_id?: string | null;
}

export interface ChatToolCallApi {
  tool: string;
  args: string;
  result?: string | null;
  error?: string | null;
}

export interface ChatMessageApi {
  id: string;
  role: "user" | "assistant";
  content: string;
  seq: number;
  created_at: string;
  tool_calls?: ChatToolCallApi[];
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
