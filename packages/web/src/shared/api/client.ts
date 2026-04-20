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
  auth: {
    login: (email: string, password: string) =>
      request<{ ok: boolean }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  },
};
