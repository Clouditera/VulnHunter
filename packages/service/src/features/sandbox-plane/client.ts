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
  constructor(message: string) {
    super(message);
    this.name = "SandboxPlaneUnavailableError";
  }
}

/** HTTP 429 RESOURCE_EXHAUSTED — health admission rejected the create (H2 §3 capacity path). */
export class SandboxPlaneCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPlaneCapacityError";
  }
}

function client() {
  const config = loadConfig();
  const { baseUrl, token, timeoutMs } = config.sandboxPlane;
  if (!baseUrl || !token) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token, timeoutMs };
}

async function request(path: string, allow404 = false): Promise<unknown | null> {
  const c = client();
  if (!c) throw new SandboxPlaneUnavailableError("SandboxPlane is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  try {
    const res = await fetch(`${c.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: controller.signal,
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      throw new SandboxPlaneUnavailableError(`SandboxPlane returned HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof SandboxPlaneUnavailableError) throw err;
    logger.warn({ err, path }, "SandboxPlane request failed");
    throw new SandboxPlaneUnavailableError("SandboxPlane request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function writeRequest(method: "POST", path: string, body?: unknown, allow404 = false): Promise<unknown | null> {
  const c = client();
  if (!c) throw new SandboxPlaneUnavailableError("SandboxPlane is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
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
      throw new SandboxPlaneUnavailableError(`SandboxPlane ${method} ${path} returned HTTP ${res.status}${code ? ` (${code})` : ""}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof SandboxPlaneUnavailableError || err instanceof SandboxPlaneCapacityError) throw err;
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

/** POST /sandboxes — idempotent on (consumer, request_id): a replay returns the existing record. */
export async function createSandboxPlaneSandbox(input: CreateSandboxInput): Promise<SandboxPlaneSandbox> {
  const body = await writeRequest("POST", "/sandboxes", {
    consumer: "vulnhunter",
    request_id: input.request_id,
    profile_id: input.profile_id,
    ssh_public_key: input.ssh_public_key,
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.external_ref ? { external_ref: input.external_ref } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  return unwrapSandbox(body, "create");
}

/** GET /sandboxes/:id — null when the instance is gone (404). */
export async function getSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox | null> {
  const body = await request(`/sandboxes/${encodeURIComponent(id)}`, true);
  if (body === null) return null;
  return unwrapSandbox(body, "get");
}

export async function stopSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox> {
  const body = await writeRequest("POST", `/sandboxes/${encodeURIComponent(id)}/stop`);
  return unwrapSandbox(body, "stop");
}

export async function resumeSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox> {
  const body = await writeRequest("POST", `/sandboxes/${encodeURIComponent(id)}/resume`);
  return unwrapSandbox(body, "resume");
}

export async function releaseSandboxPlaneSandbox(id: string): Promise<SandboxPlaneSandbox> {
  const body = await writeRequest("POST", `/sandboxes/${encodeURIComponent(id)}/release`);
  return unwrapSandbox(body, "release");
}
