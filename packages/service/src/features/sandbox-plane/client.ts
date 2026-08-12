/**
 * SandboxPlane HTTP client — read-only list/get against the SandboxPlane
 * `GET /profiles` and `GET /profiles/:id` endpoints.
 *
 * Holds the real SandboxPlane service token (loaded from server-side config).
 * This module never runs inside a worker container; only the VulnHunter
 * service process calls it, from the internal proxy routes.
 */
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";

export interface SandboxPlaneRawProfile {
  profile_id: string;
  status: "available" | "disabled" | "unavailable";
  backend_type: "docker" | "docker+sysbox" | "qemu";
  capabilities: string[];
  default_resources?: { cpu?: number; memory_mb?: number; disk_gb?: number };
}

/** Serialized sandbox record (SandboxPlane serializeSandbox, v0.3.1). */
export interface SandboxPlaneSandbox {
  sandbox_id: string;
  request_id: string;
  consumer: string;
  profile_id: string;
  status: "requested" | "provisioning" | "running" | "stopped" | "releasing" | "released" | "failed" | "expired";
  ssh: { host: string; port: number; user: string } | null;
  /** v0.3.2: docker-internal IP for bastion ProxyJump (null on older planes). */
  ssh_internal_host?: string | null;
  /** v0.3.2: per-instance host public key for StrictHostKeyChecking pin (null = TOFU fallback). */
  ssh_host_public_key?: string | null;
  resources?: { cpu?: number; memory_mb?: number; disk_gb?: number };
  external_ref: string | null;
  failure_reason: string | null;
  error_code: string | null;
}

export class SandboxPlaneUnavailableError extends Error {
  readonly httpStatus?: number;
  readonly planeCode?: string;
  constructor(
    message: string,
    opts?: { httpStatus?: number; planeCode?: string },
  ) {
    super(message);
    this.name = "SandboxPlaneUnavailableError";
    this.httpStatus = opts?.httpStatus;
    this.planeCode = opts?.planeCode;
  }
}

/** HTTP 429 RESOURCE_EXHAUSTED — health admission rejected the create (H2 §3 capacity path). */
export class SandboxPlaneCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPlaneCapacityError";
  }
}

/**
 * Client aborted the HTTP call (AbortController / timeout).
 * Distinct from HTTP 4xx/5xx so callers can poll plane truth after a slow
 * lifecycle POST that may still complete server-side (fish 2026-08-10).
 */
export class SandboxPlaneTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "SandboxPlaneTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function client() {
  const config = loadConfig();
  const { baseUrl, token, timeoutMs, writeTimeoutMs } = config.sandboxPlane;
  if (!baseUrl || !token) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    timeoutMs,
    writeTimeoutMs,
  };
}

/** True when SANDBOXPLANE_BASE_URL + TOKEN are set (plane may still be down). */
export function isSandboxPlaneConfigured(): boolean {
  return client() != null;
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

async function request(path: string, allow404 = false, opts?: { timeoutMs?: number }): Promise<unknown | null> {
  const c = client();
  if (!c) throw new SandboxPlaneUnavailableError("SandboxPlane is not configured");

  const timeoutMs = opts?.timeoutMs ?? c.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: controller.signal,
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      throw new SandboxPlaneUnavailableError(`SandboxPlane returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }
    return await res.json();
  } catch (err) {
    if (err instanceof SandboxPlaneUnavailableError) throw err;
    if (isAbortError(err)) {
      throw new SandboxPlaneTimeoutError(
        `SandboxPlane request timed out after ${Math.round(timeoutMs / 1000)}s (${path})`,
        timeoutMs,
      );
    }
    logger.warn({ err, path }, "SandboxPlane request failed");
    throw new SandboxPlaneUnavailableError("SandboxPlane request failed");
  } finally {
    clearTimeout(timer);
  }
}

export interface WriteRequestOpts {
  allow404?: boolean;
  /** Override default read timeout for this write. */
  timeoutMs?: number;
}

async function writeRequest(
  method: "POST",
  path: string,
  body?: unknown,
  opts: WriteRequestOpts = {},
): Promise<unknown | null> {
  const c = client();
  if (!c) throw new SandboxPlaneUnavailableError("SandboxPlane is not configured");

  const timeoutMs = opts.timeoutMs ?? c.timeoutMs;
  const allow404 = opts.allow404 ?? false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const parsed = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      const code = parsed?.error?.code;
      if (res.status === 429 && code === "RESOURCE_EXHAUSTED") {
        throw new SandboxPlaneCapacityError("SandboxPlane admission rejected create: capacity exhausted");
      }
      throw new SandboxPlaneUnavailableError(
        `SandboxPlane ${method} ${path} returned HTTP ${res.status}${code ? ` (${code})` : ""}`,
        { httpStatus: res.status, planeCode: code },
      );
    }
    return await res.json();
  } catch (err) {
    if (
      err instanceof SandboxPlaneUnavailableError ||
      err instanceof SandboxPlaneCapacityError ||
      err instanceof SandboxPlaneTimeoutError
    ) {
      throw err;
    }
    if (isAbortError(err)) {
      throw new SandboxPlaneTimeoutError(
        `SandboxPlane write timed out after ${Math.round(timeoutMs / 1000)}s (${method} ${path})`,
        timeoutMs,
      );
    }
    logger.warn({ err, path }, "SandboxPlane write request failed");
    throw new SandboxPlaneUnavailableError("SandboxPlane write request failed");
  } finally {
    clearTimeout(timer);
  }
}

function isRawProfile(value: unknown): value is SandboxPlaneRawProfile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.profile_id === "string" &&
    v.profile_id.length > 0 &&
    (v.status === "available" || v.status === "disabled" || v.status === "unavailable") &&
    (v.backend_type === "docker" || v.backend_type === "docker+sysbox" || v.backend_type === "qemu") &&
    Array.isArray(v.capabilities) &&
    v.capabilities.every((cap) => typeof cap === "string")
  );
}

export async function listSandboxPlaneProfiles(): Promise<SandboxPlaneRawProfile[]> {
  const body = await request("/profiles");
  const profiles = (body as { profiles?: unknown })?.profiles;
  if (!Array.isArray(profiles) || !profiles.every(isRawProfile)) {
    throw new SandboxPlaneUnavailableError("SandboxPlane returned a malformed profile list");
  }
  return profiles;
}

export async function getSandboxPlaneProfile(profileId: string): Promise<SandboxPlaneRawProfile | null> {
  const body = await request(`/profiles/${encodeURIComponent(profileId)}`, true);
  if (body === null) return null;
  const profile = (body as { profile?: unknown })?.profile;
  if (!isRawProfile(profile)) {
    throw new SandboxPlaneUnavailableError("SandboxPlane returned a malformed profile");
  }
  return profile;
}

function isSandbox(value: unknown): value is SandboxPlaneSandbox {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sandbox_id === "string" && v.sandbox_id.length > 0 &&
    typeof v.request_id === "string" &&
    typeof v.status === "string"
  );
}

function unwrapSandbox(body: unknown, what: string): SandboxPlaneSandbox {
  const sandbox = (body as { sandbox?: unknown })?.sandbox;
  if (!isSandbox(sandbox)) throw new SandboxPlaneUnavailableError(`SandboxPlane returned a malformed sandbox on ${what}`);
  return sandbox;
}

export interface CreateSandboxInput {
  request_id: string;
  profile_id: string;
  ssh_public_key: string;
  resources?: { cpu?: number; memory_mb?: number; disk_gb?: number };
  external_ref?: string;
  metadata?: Record<string, unknown>;
}

/**
 * POST /sandboxes — idempotent on (consumer, request_id): a replay returns the existing record.
 * Uses write timeout tier (default 60s). Callers must treat SandboxPlaneTimeoutError as
 * "POST may still complete" and re-POST (idempotent) then poll until running
 * (fish 2026-08-10 create same-family as resume).
 */
export async function createSandboxPlaneSandbox(input: CreateSandboxInput): Promise<SandboxPlaneSandbox> {
  const c = client();
  if (!c) throw new SandboxPlaneUnavailableError("SandboxPlane is not configured");
  const body = await writeRequest(
    "POST",
    "/sandboxes",
    {
      consumer: "vulnhunter",
      request_id: input.request_id,
      profile_id: input.profile_id,
      ssh_public_key: input.ssh_public_key,
      ...(input.resources ? { resources: input.resources } : {}),
      ...(input.external_ref ? { external_ref: input.external_ref } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    { timeoutMs: c.writeTimeoutMs },
  );
  return unwrapSandbox(body, "create");
}

/** GET /sandboxes/:id — null when the instance is gone (404). */
export async function getSandboxPlaneSandbox(id: string, opts?: { timeoutMs?: number }): Promise<SandboxPlaneSandbox | null> {
  const body = await request(`/sandboxes/${encodeURIComponent(id)}`, true, opts);
  if (body === null) return null;
  return unwrapSandbox(body, "get");
}

/** stop/release: longer than read default, shorter than resume (architect 15s). */
const STOP_RELEASE_TIMEOUT_MS = 15_000;

export async function stopSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox> {
  const body = await writeRequest("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, undefined, {
    timeoutMs: STOP_RELEASE_TIMEOUT_MS,
  });
  return unwrapSandbox(body, "stop");
}

/**
 * POST resume with write timeout (default 60s via SANDBOXPLANE_WRITE_TIMEOUT_MS).
 * Callers must treat SandboxPlaneTimeoutError as "POST may still be in flight"
 * and poll GET until running (see lifecycle resumeAndReconcile).
 */
export async function resumeSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox> {
  const c = client();
  if (!c) throw new SandboxPlaneUnavailableError("SandboxPlane is not configured");
  const body = await writeRequest("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, undefined, {
    timeoutMs: c.writeTimeoutMs,
  });
  return unwrapSandbox(body, "resume");
}

export async function releaseSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox> {
  const body = await writeRequest("POST", `/sandboxes/${encodeURIComponent(id)}/release`, undefined, {
    timeoutMs: STOP_RELEASE_TIMEOUT_MS,
  });
  return unwrapSandbox(body, "release");
}
