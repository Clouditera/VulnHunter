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

export interface Task {
  id: string;
  project_name: string;
  state: string;
  risk_score: number | null;
  failure_reason: string | null;
  source_type: string;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
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
};
