import type { FindingDynamicMeta, SystemStatus, TaskMetadata as SharedTaskMetadata } from "@vulnhunter/shared";
import { ERROR_REGISTRY, type ErrorCode } from "@vulnhunter/shared";
import { i18n } from "../i18n/index.js";

const BASE = "";

type ApiErrorShape = { error?: { code?: string; detail?: string; message?: string; used?: number; limit?: number } };

type ClientError = Error & { code: string; used?: number; limit?: number };

function buildApiError(status: number, body?: ApiErrorShape | null): ClientError {
  const error = body?.error;
  const code = error?.code ?? (status === 413 ? "ERR_UPLOAD_GATEWAY_LIMIT" : "ERR_INTERNAL");
  // Fallback chain: server detail → server message → registry i18n → status hint → code
  const registryEntry = code in ERROR_REGISTRY ? ERROR_REGISTRY[code as ErrorCode] : undefined;
  const registryMsg = registryEntry ? i18n.t(registryEntry.i18nKey) : undefined;
  const detail = error?.detail ?? error?.message ?? registryMsg ?? (status === 413 ? "HTTP 413" : code);
  const err = new Error(detail) as ClientError;
  err.code = code;
  err.used = error?.used;
  err.limit = error?.limit;
  return err;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as ApiErrorShape | null;
    throw buildApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
  info: number;
}

export interface CreatorSummary {
  id: string;
  display_name: string;
  email: string;
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
  stages_total?: number | null;
  stages_failed?: number | null;
  warning?: string | null;
  total_tokens_in?: number | null;
  total_tokens_out?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  total_tokens?: number | null;
  tool_call_count?: number | null;
}

export interface TaskMetadata extends SharedTaskMetadata {
  profile?: TaskProfile;
  execution?: TaskExecution;
}

export interface Task {
  id: string;
  project_name: string;
  display_name?: string | null;
  state: string;
  /**
   * Why a completed task ended: "natural" (default) | "timeout" (scan time
   * budget exhausted). Absent on older rows / until backend lands (mock-ready).
   */
  completion_reason?: "natural" | "timeout" | null;
  sandbox_queue?: SandboxQueueInfo | null;
  risk_score: number | null;
  failure_reason: string | null;
  source_type: string;
  duration_ms: number | null;
  /**
   * Accumulated duration across all run segments (fish 2026-08-08,
   * task-70ebb6d0): first run + every continuation; reset to 0 on a fresh
   * re-scan. Absent/zero on pre-migration rows → fall back to duration_ms.
   */
  total_duration_ms?: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  tool_call_count: number;
  stage_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  /** Populated by GET /api/tasks (list) — absent on single-task GET. */
  severity_counts?: SeverityCounts;
  /** Admin-only creator summary populated on list endpoints. */
  creator?: CreatorSummary;
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

export type FindingReviewStatus = 'pending' | 'confirmed' | 'false_positive' | 'ignored';

export type FindingItemType = "finding" | "risk";

/** H4 artifact read API shapes (mirrors service artifacts.ts). */
export type ArtifactKind = "text" | "image" | "binary";
export interface ArtifactFileEntry {
  path: string;
  size: number;
  kind: ArtifactKind;
  previewable: boolean;
}
export interface FindingArtifactGroups {
  poc: { files: ArtifactFileEntry[] };
  exp: { files: ArtifactFileEntry[] };
}
export interface ArtifactFilePreview {
  kind: ArtifactKind;
  size: number;
  language?: string;
  content?: string;
  truncated: boolean;
  mime?: string;
  data_base64?: string;
}

/** H4 EXP page (GET /tasks/:id/exploits). */
export type ExploitPageState = "not_enabled" | "pending" | "running" | "done";
export interface ChainReportProjection {
  title: string | null;
  members: string[];
  cwe: string | null;
  cvss_vector: string | null;
  cvss_score: number | null;
  ev_vector: string | null;
  ev_score: number | null;
  ev_priority: string | null;
  background: string | null;
  combined_impact: string | null;
  chain: Array<{ step: number | string | null; finding: string | null; role: string | null; evidence: string | null }>;
}
export interface ExploitChainEntry {
  id: string;
  report?: ChainReportProjection;
  parse_error?: boolean;
}
export interface ExploitPageData {
  state: ExploitPageState;
  chains: ExploitChainEntry[];
}

export interface FindingMeta extends FindingDynamicMeta {
  id: string;
  task_id: string;
  finding_key: string;
  severity: string;
  severity_numeric: number;
  vuln_type: string | null;
  vuln_type_full: string | null;
  title: string | null;
  primary_file: string | null;
  primary_line: number | null;
  function_name: string | null;
  cwe: string | null;
  cvss_vector: string | null;
  cvss_score: number | null;
  ev_vector: string | null;
  ev_score: number | null;
  ev_priority: string | null;
  ev_rationale: string | null;
  item_type: FindingItemType;
  user_verdict: string;
  review_status: FindingReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface FindingItemCounts {
  finding: number;
  risk: number;
  all: number;
}

export interface FindingReviewEvent {
  id: string;
  task_id: string;
  finding_key: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  old_status: FindingReviewStatus;
  new_status: FindingReviewStatus;
  note: string | null;
  created_at: string;
}


export type ApiTokenStatus = "active" | "disabled" | "expired" | "revoked";

export interface ApiToken {
  id: string;
  name: string;
  token_prefix: string | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  status: ApiTokenStatus;
}

export const api = {
  system: {
    status: () => request<SystemStatus>("/api/system/status"),
    activate: (cert: string) => request<{ ok: boolean }>("/api/system/activate", {
      method: "POST",
      body: JSON.stringify({ cert }),
    }),
    /** First-run wizard: create the initial admin (admin-console setup
     *  endpoint; triple-sealed backend — 403 once an admin exists). */
    createInitialAdmin: (email: string, password: string) =>
      request<{ ok: boolean }>("/api/admin/setup/admin", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
  },
  git: {
    branches: (url: string) => request<{ default_branch: string | null; branches: string[] }>(`/api/git/branches?url=${encodeURIComponent(url)}`),
  },
  tasks: {
    list: (filters?: string | {
      state?: string;
      reviewStatus?: string;
      userId?: string;
      paginate?: boolean;
      page?: number;
      pageSize?: number;
      q?: string;
      sort?: "newest" | "oldest" | "name";
    }) => {
      const params = new URLSearchParams();
      if (typeof filters === "string") {
        params.set("state", filters);
      } else if (filters) {
        if (filters.state) params.set("state", filters.state);
        if (filters.reviewStatus) params.set("review_status", filters.reviewStatus);
        if (filters.userId) params.set("user_id", filters.userId);
        if (filters.q) params.set("q", filters.q);
        if (filters.sort) params.set("sort", filters.sort);
        if (filters.paginate) {
          params.set("paginate", "1");
          if (filters.page) params.set("page", String(filters.page));
          if (filters.pageSize) params.set("page_size", String(filters.pageSize));
        }
      }
      const qs = params.toString();
      return request<{
        tasks: Task[];
        total?: number;
        page?: number;
        page_size?: number;
        total_pages?: number;
      }>(`/api/tasks${qs ? `?${qs}` : ""}`);
    },
    get: (id: string) => request<{ task: Task }>(`/api/tasks/${id}`),
    sourceArchivePolicy: () => request<SourceArchivePolicy>("/api/tasks/source-archive-policy"),
    create: (
      body:
        | FormData
        | {
            git_url: string;
            git_branch?: string;
            project_name?: string;
            display_name?: string;
            credential_id?: string;
            audit_focus?: string;
            scan_timeout?: number;
            timeout_mode?: "custom" | "auto";
            max_items_per_recon?: number;
            enable_dynamic_verify?: boolean;
            enable_dynamic_exploit?: boolean; agent_max_parallel?: number;
          },
    ) =>
      body instanceof FormData
        ? fetch("/api/tasks", { method: "POST", credentials: "include", body }).then(async (r) => {
            const parsed = await r.json().catch(() => null) as ApiErrorShape | { task: Task } | null;
            if (!r.ok) throw buildApiError(r.status, parsed as ApiErrorShape | null);
            return parsed as { task: Task };
          })
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
            try {
              reject(buildApiError(xhr.status, JSON.parse(xhr.responseText)));
              return;
            } catch {}
            reject(buildApiError(xhr.status));
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.onabort = () => reject(new Error("Upload aborted"));
        xhr.send(body);
      }),
    update: (id: string, body: { credential_id?: string | null }) =>
      request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    updateDisplayName: (id: string, display_name: string | null) =>
      request<{ task: Task }>(`/api/tasks/${id}/display-name`, { method: "PATCH", body: JSON.stringify({ display_name }) }),
    cancel: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/cancel`, { method: "POST" }),
    /** H4: read-only single-artifact-file preview (whitelisted findings/exploits roots). */
    artifactFile: (id: string, path: string) =>
      request<ArtifactFilePreview>(`/api/tasks/${id}/artifacts/file?path=${encodeURIComponent(path)}`),
    /** H4: EXP independent page data (server-derived four-state + chain projections). */
    exploits: (id: string) =>
      request<ExploitPageData>(`/api/tasks/${id}/exploits`),
    /** H4: single exploit chain's companion artifact file list (exploits/<id>/). */
    exploitArtifacts: (id: string, exploitId: string) =>
      request<{ files: ArtifactFileEntry[] }>(`/api/tasks/${id}/exploits/${encodeURIComponent(exploitId)}/artifacts`),
    pause: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/pause`, { method: "POST" }),
    resume: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/resume`, { method: "POST" }),
    restart: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}/restart`, { method: "POST" }),
    continue: (id: string, params?: { audit_focus?: string; scan_timeout?: number }) =>
      request<{ ok: boolean }>(`/api/tasks/${id}/continue`, {
        method: "POST",
        body: JSON.stringify(params ?? {}),
      }),
    delete: (id: string) => request<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
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
    wikiPage: (id: string, filename: string) =>
      request<WikiPageContent>(`/api/tasks/${id}/wiki/page/${encodeURIComponent(filename)}`),
    profiler: (id: string) =>
      request<{ profiler: ProfilerData | null }>(`/api/tasks/${id}/profiler`),
    coverage: (id: string) =>
      request<CoveragePayload>(`/api/tasks/${id}/coverage`),
    /** Full per-file + per-dir audit-progress map (detail=full) for the code-tree overlay. */
    auditProgress: (id: string) =>
      request<AuditProgressPayload>(`/api/tasks/${id}/coverage?detail=full`),
    /** Historical events for a finished task. Backend prefers the in-memory
     *  ring buffer when present (running tasks), falling back to MinIO
     *  archive `scan-outputs/<id>/.youngflow/logs/youngflow.service.jsonl`
     *  for terminal tasks. Returns canonical translated events ready for
     *  the LiveLog renderer. */
    events: (id: string) =>
      request<{ events: Array<Record<string, unknown>>; total?: number }>(
        `/api/tasks/${id}/events`,
      ),
  },
  findings: {
    list: (taskId: string, filters?: { severity?: string; itemType?: FindingItemType | "all"; reviewStatus?: FindingReviewStatus[]; limit?: number; offset?: number; search?: string }) => {
      const params = new URLSearchParams();
      if (filters?.severity) params.set("severity", filters.severity);
      if (filters?.itemType) params.set("item_type", filters.itemType);
      if (filters?.reviewStatus?.length) params.set("review_status", filters.reviewStatus.join(","));
      if (filters?.limit) params.set("limit", String(filters.limit));
      if (filters?.offset) params.set("offset", String(filters.offset));
      if (filters?.search) params.set("search", filters.search);
      const qs = params.toString();
      return request<{ findings: FindingMeta[]; total: number; counts: FindingItemCounts }>(`/api/tasks/${taskId}/findings${qs ? `?${qs}` : ""}`);
    },
    detail: (taskId: string, key: string) =>
      request<{ meta: FindingMeta; detail: FindingDetail }>(
        `/api/tasks/${taskId}/findings/${encodeURIComponent(key)}`,
      ),
    /** H4: per-finding POC/EXP artifact file lists for the three cards. */
    artifacts: (taskId: string, findingId: string) =>
      request<FindingArtifactGroups>(
        `/api/tasks/${taskId}/findings/${encodeURIComponent(findingId)}/artifacts`,
      ),
    updateReview: (taskId: string, findingKey: string, body: { review_status: FindingReviewStatus; note?: string }) =>
      request<{ finding: FindingMeta; event: FindingReviewEvent }>(
        `/api/tasks/${taskId}/findings/${encodeURIComponent(findingKey)}/review`,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    bulkUpdateReview: (taskId: string, body: { finding_keys: string[]; review_status: FindingReviewStatus; note?: string }) =>
      request<{ updated: number; findings: FindingMeta[] }>(
        `/api/tasks/${taskId}/findings/review/bulk`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    reviewEvents: (taskId: string, findingKey: string) =>
      request<{ events: FindingReviewEvent[] }>(
        `/api/tasks/${taskId}/findings/${encodeURIComponent(findingKey)}/review-events`,
      ),
  },
  settings: {
    getCredential: () => request<{ credential: LlmCredential | null }>("/api/settings/credential"),
    /** Reveal a saved API key after an explicit eye-button action. */
    revealCredentialKey: (id: string) =>
      request<{ api_key: string }>(`/api/settings/credentials/${id}/key`),
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
    patchCredential: (id: string, meta: { provider?: string; proto_type?: string; base_url?: string; model_id?: string; thinking_effort?: string; label?: string; context_window_tokens?: number }) =>
      request<{ ok: boolean }>(`/api/settings/credential/${id}`, {
        method: "PATCH",
        body: JSON.stringify(meta),
      }),
    getSystemConfig: () => request<{ config: SystemConfig }>("/api/admin/system-config"),
    updateSystemConfig: (patch: Partial<SystemConfig>) =>
      request<{ ok: boolean }>("/api/admin/system-config", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    listModels: (params?: { base_url?: string; api_key?: string; proto_type?: string; credential_id?: string }) =>
      request<{ models: Array<{ id: string; owned_by?: string }>; error?: string }>(
        "/api/settings/models",
        { method: "POST", body: JSON.stringify(params ?? {}) },
      ),
  },
  users: {
    list: () => request<{ users: UserApi[] }>("/api/admin/users"),
    create: (data: { email: string; password: string; display_name?: string; role?: string; must_change_password?: boolean; task_limit?: number; admin_remark?: string | null }) =>
      request<{ user: UserApi }>("/api/admin/users", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: { display_name?: string; role?: string; status?: string; reset_password?: string; task_limit?: number; admin_remark?: string | null }) =>
      request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
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
    updateMe: (data: { display_name?: string; onboarding_dismissed?: boolean }) =>
      request<{ ok: boolean }>("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    /** Registration — request email verification code */
    registerRequestCode: (email: string) =>
      request<{ ok: boolean; cooldown_seconds: number }>("/api/auth/register/request-code", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    /** Registration — verify code + set password, auto-login */
    registerVerify: (data: {
      email: string;
      code: string;
      password: string;
      display_name?: string;
      /** required true — backend records agreement acceptances */
      accept_agreements: boolean;
    }) =>
      request<{ user: { id: string; email: string; displayName: string; role: string; mustChangePassword: boolean }; session?: unknown }>(
        "/api/auth/register/verify",
        { method: "POST", body: JSON.stringify(data) },
      ),
    listAgreements: () =>
      request<{
        agreements: Array<{
          id: string;
          title: string;
          version: string;
          effective_date: string;
          required_on_register: boolean;
          html_url: string;
        }>;
      }>("/api/auth/agreements"),
    getAgreement: (id: string) =>
      request<{ id: string; title: string; version: string; effective_date: string; html: string }>(
        `/api/auth/agreements/${encodeURIComponent(id)}?format=json`,
      ),
    /** Forgot password — always ok (no email existence leak) */
    passwordForgot: (email: string) =>
      request<{ ok: boolean }>("/api/auth/password/forgot", {
        method: "POST",
        body: JSON.stringify({ email }),
      }),
    passwordReset: (data: { email: string; code: string; new_password: string }) =>
      request<{ ok: boolean }>("/api/auth/password/reset", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },
  settingsSmtp: {
    get: () => request<SmtpConfigView>("/api/admin/smtp"),
    put: (data: {
      host: string;
      port: number;
      username: string;
      password?: string;
      from_address: string;
      encryption: "none" | "ssl" | "starttls";
    }) => request<{ ok: boolean }>("/api/admin/smtp", { method: "PUT", body: JSON.stringify(data) }),
    test: (to: string) =>
      request<{ ok: boolean; detail?: string }>("/api/admin/smtp/test", {
        method: "POST",
        body: JSON.stringify({ to }),
      }),
  },
  sandbox: {
    capacity: () => request<SandboxCapacity>("/api/sandbox/capacity"),
  },
  promo: {
    cloudrouter: {
      get: () =>
        request<{ enabled: boolean; my_code: string | null; available: boolean }>(
          "/api/promo/cloudrouter",
        ),
      claim: () =>
        request<{
          ok: boolean;
          code: string | null;
          already_claimed?: boolean;
          pool_empty?: boolean;
        }>("/api/promo/cloudrouter/claim", { method: "POST", body: "{}" }),
      balance: () =>
        request<
          | {
              available: true;
              remaining: number | null;
              unit: string | null;
              planName: string | null;
              mode: string | null;
              updated_at: string;
            }
          | { available: false }
        >("/api/promo/cloudrouter/balance"),
    },
  },
    feedback: {
    submit: (data: { satisfaction: number; content: string; contact_email?: string | null }) =>
      request<{ ok: boolean; feedback: FeedbackItem }>("/api/feedback", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    list: (opts?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      if (opts?.offset != null) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return request<{ total: number; feedback: FeedbackItem[] }>(`/api/admin/feedback${qs ? `?${qs}` : ""}`);
    },
  },
  home: {
    stats: () => request<{ stats: HomePublicStats }>("/api/system/home-stats"),
  },
  dashboard: {
    get: (range?: string, userId?: string) => {
      const params = new URLSearchParams();
      if (range) params.set("range", range);
      if (userId) params.set("user_id", userId);
      const qs = params.toString();
      return request<DashboardData>(`/api/dashboard${qs ? `?${qs}` : ""}`);
    },
  },
  chat: {
    sessions: {
      /** With limit/offset → paged shape; without → legacy list (next_offset/total absent). */
      list: (opts?: { limit?: number; offset?: number }): Promise<{
        sessions: ChatSessionApi[];
        next_offset?: number | null;
        total?: number;
      }> => {
        if (opts?.limit != null || opts?.offset != null) {
          const params = new URLSearchParams();
          if (opts.limit != null) params.set("limit", String(opts.limit));
          if (opts.offset != null) params.set("offset", String(opts.offset));
          return request<{ sessions: ChatSessionApi[]; next_offset: number | null; total: number }>(
            `/api/chat/sessions?${params}`,
          );
        }
        return request<{ sessions: ChatSessionApi[] }>("/api/chat/sessions");
      },
      search: (q: string) =>
        request<{
          query: string;
          results: Array<{ session: ChatSessionApi; match: string; snippet: string | null }>;
          groups: {
            today: ChatSessionApi[];
            yesterday: ChatSessionApi[];
            last_7_days: ChatSessionApi[];
            this_year: ChatSessionApi[];
            earlier: ChatSessionApi[];
          };
        }>(`/api/chat/sessions/search?q=${encodeURIComponent(q)}`),
      rename: (id: string, title: string) =>
        request<{ session: ChatSessionApi }>(`/api/chat/sessions/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title }),
        }),
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
       * attachments directory and returns `{ artifact_id, path, originalFilename }`.
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
            artifact_id: string;
            path: string;
            originalName: string;
          }>;
        });
      },
      artifacts: (id: string) =>
        request<{ artifacts: ChatArtifactApi[] }>(`/api/chat/sessions/${id}/artifacts`),
      artifactDownloadUrl: (id: string, artifactId: string) =>
        `/api/chat/sessions/${id}/artifacts/${artifactId}/download`,
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
  creditCodes: {
    list: (opts?: { status?: "available" | "assigned"; page?: number; page_size?: number }) => {
      const params = new URLSearchParams();
      if (opts?.status) params.set("status", opts.status);
      if (opts?.page != null) params.set("page", String(opts.page));
      if (opts?.page_size != null) params.set("page_size", String(opts.page_size));
      const qs = params.toString();
      return request<{
        items: CreditCodeItem[];
        page: number;
        page_size: number;
        total: number;
        counts: { available: number; assigned: number };
      }>(`/api/admin/credit-codes${qs ? `?${qs}` : ""}`);
    },
    import: (text: string) =>
      request<{
        ok: boolean;
        inserted: number;
        skipped_duplicates: number;
        invalid: number;
        invalid_samples: string[];
      }>("/api/admin/credit-codes/import", {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/api/admin/credit-codes/${id}`, { method: "DELETE" }),
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
  apiTokens: {
    list: () =>
      request<{ tokens: ApiToken[]; limit: number; count: number }>("/api/me/api-tokens"),
    create: (body: { name: string; expires_in_days: number | null }) =>
      request<{ token: ApiToken; plaintext: string; limit: number }>("/api/me/api-tokens", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    rename: (id: string, name: string) =>
      request<{ token: ApiToken }>(`/api/me/api-tokens/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    setStatus: (id: string, status: "active" | "disabled") =>
      request<{ token: ApiToken }>(`/api/me/api-tokens/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    /** Hard delete (row removed, quota released). Was soft-revoke pre-2.3.4. */
    remove: (id: string) =>
      request<{ ok: boolean }>(`/api/me/api-tokens/${id}`, { method: "DELETE" }),
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
      body: { skill_id?: string | null; credential_id?: string; finding_keys?: string[] },
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
  credential_health?: "ok" | "decrypt_failed" | "key_unavailable" | "unknown";
  /** L4 deep verification (agent-loop) state — present once B核-B/B4 wiring lands. */
  deep_verified_status?: "pending" | "running" | "passed" | "failed" | null;
  deep_verified_at?: string | null;
  key_fingerprint?: string | null;
  current_key_fingerprint?: string;
  context_window_tokens: number;
  /**
   * Vendor-adaptation config (fish 2026-08-08, design §3.1a): sparse object
   * holding only non-default compat/thinkingLevelMap/input/cost values;
   * null/absent = all defaults (「使用默认配置」).
   */
  advanced_config?: Record<string, unknown> | null;
  owner_id?: string | null;
  scope?: "global" | "personal";
  can_edit?: boolean;
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
  context_window_tokens?: number;
  /** Sparse vendor-adaptation config; null clears to defaults. */
  advanced_config?: Record<string, unknown> | null;
  owner_id?: string | null;
}

export interface ModelDiagnosticCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "warn" | "skip" | "na" | "pending" | "running";
  category?: string;
  message: string;
  detail?: string;
  suggestion?: string;
  httpStatus?: number;
  endpoint?: string;
  durationMs?: number;
}

export interface ModelDiagnosticResult {
  ok: boolean;
  summary: string;
  checks: ModelDiagnosticCheck[];
}

export interface SourceArchivePolicy {
  max_mb: number;
  max_bytes: number;
  gateway_max_mb?: number;
  effective_max_mb?: number;
  source_archive_upload_ceiling_mb: number;
  formats: string[];
  extensions: string[];
  accept: string;
}

export interface CreditCodeItem {
  id: string;
  code: string;
  status: "available" | "assigned";
  assigned_user_email: string | null;
  assigned_at: string | null;
  created_at: string;
}

export interface SystemConfig {

  max_parallel_scan: number;
  tasks_page_size?: number;
  /** @deprecated task-level agent_max_parallel; may still exist in legacy DB */
  youngflow_max_parallel?: number;
  max_parallel_chat: number;
  max_parallel_report: number;
  scan_cpu_limit: number;
  scan_memory_gb: number;
  chat_cpu_limit: number;
  chat_memory_gb: number;
  report_cpu_limit: number;
  report_memory_gb: number;
  source_archive_upload_max_mb: number;
  upload_zip_max_mb: number;
  upload_gateway_limit_mb?: number;
  source_archive_upload_ceiling_mb?: number;
  source_archive_effective_max_mb?: number;
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

export interface UserApi {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  /** 'admin' | 'registered' — source of account creation */
  source?: string;
  /** Deploy-provisioned system admin — protected in UI + API */
  is_system?: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string;
  task_limit?: number;
  task_count?: number;
  admin_remark?: string | null;
}

export interface HomePublicStats {
  findings_total: number;
  findings_high: number;
  tasks_completed: number;
  as_of: string;
}

export interface FeedbackItem {
  id: string;
  satisfaction: number;
  content: string;
  contact_email: string | null;
  created_at: string;
  user?: { id: string; email: string | null; display_name: string | null } | null;
}

export interface SandboxCapacity {
  available_now: boolean;
  running_sandboxes: number;
  queue_depth: number;
  detail: "ok" | "capacity_tight" | "not_configured" | "unavailable";
  configured: boolean;
}

export interface SandboxQueueInfo {
  waiting: boolean;
  reason?: "capacity" | "quota" | string;
  since?: string;
  attempts?: number;
}

export interface SmtpConfigView {
  configured: boolean;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  /** password never returned — only whether one is stored */
  password_configured?: boolean;
  from_address?: string | null;
  encryption?: "none" | "ssl" | "starttls" | string;
  last_tested_at?: string | null;
  last_test_ok?: boolean | null;
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
  mime?: string;
  data_base64?: string;
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

export interface WikiPageEntry {
  name: string;
  path: string;
}

export interface WikiPageContent {
  name: string;
  content: string;
}

/* -------------------------------------------------------------------------- */
/*  Profiler + Coverage (Phase 4)                                            */
/* -------------------------------------------------------------------------- */

export interface ProfilerLanguage {
  name: string;
  percentage: number;
}

export interface ProfilerData {
  basic_info?: { project_name?: string };
  code_stats?: {
    file_count?: number;
    loc?: number;
    languages?: ProfilerLanguage[];
  };
  tech_stack?: {
    build_system?: string;
    package_manager?: string;
    main_dependencies?: string[];
  };
  [key: string]: unknown;
}

export interface CoverageSummary {
  path?: string;
  files: number;
  covered_files: number;
  total_lines: number;
  read_lines: number;
  coverage: number;
}

export interface CoveragePayload {
  summary: CoverageSummary | null;
  directories?: CoverageSummary[];
}

/** Slim coverage node for the audit-progress tree overlay (detail=full). */
export interface AuditProgressNode {
  path: string;
  coverage: number;
  read_lines: number;
  total_lines: number;
  /** Present on directory nodes only. */
  files?: number;
  covered_files?: number;
}

export interface AuditProgressPayload {
  summary: CoverageSummary | null;
  directories: AuditProgressNode[];
  files: AuditProgressNode[];
}

export interface WikiPayload {
  /** VulnForge wiki mode: present when knowledge/wiki/*.md exists. */
  pages?: WikiPageEntry[];
  /** Name of the page whose content is preloaded in indexContent. */
  indexName?: string;
  /** Preloaded content of the index/first page (no extra round trip). */
  indexContent?: string;
  /** Legacy mode fields (profiler/aggregator) — present when no VulnForge wiki. */
  profiler?: WikiProfiler | null;
  reports?: WikiReport[];
  features?: WikiFeatureEnvelope[];
  featureGroups?: WikiFeatureGroupEnvelope[];
  analysisSummaries?: WikiAnalysisSummary[];
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
  /** Admin-only creator summary populated on list endpoints. */
  creator?: CreatorSummary;
}

export interface ChatToolCallApi {
  tool: string;
  args: string;
  result?: string | null;
  error?: string | null;
}

export interface ChatMessageApi {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  seq: number;
  created_at: string;
  tool_calls?: ChatToolCallApi[];
}

export interface ChatArtifactApi {
  artifact_id: string;
  title: string;
  filename: string;
  original_name?: string;
  mime_type: string;
  size_bytes: number;
  preview?: string;
  preview_status?: "ready" | "unsupported" | "failed";
  preview_truncated?: boolean;
  download_url: string;
  created_at?: string;
  workspace_path?: string | null;
}

export interface DashboardData {
  range: string;
  stats: {
    total_scans: { value: number; delta: string };
    vulnerabilities: { value: number; delta: string };
    avg_duration_min: { value: number; delta: string };
    total_tokens?: { value: number; delta: string };
  };
  severity_dist: Record<string, number>;
  review_status_dist?: { pending: number; confirmed: number; false_positive: number; ignored: number };
  vulnerability_type_top5: Array<{ vuln_type: string; count: number }>;
  recent_scans: Array<{
    id: string;
    project_name: string;
    state: string;
    severity_counts: { h: number; m: number; l: number; i: number };
    duration_ms: number | null;
    created_at: string;
  }>;
}
