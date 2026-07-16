/**
 * SandboxPlane HTTP client — read-only list/get against the SandboxPlane
 * `GET /profiles` and `GET /profiles/:id` endpoints.
 *
 * Holds the real SandboxPlane service token (loaded from server-side config).
 * This module never runs inside a worker container; only the VulnAgent
 * service process calls it, from the internal proxy routes.
 */
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";

export interface SandboxPlaneRawProfile {
  profile_id: string;
  status: "available" | "disabled" | "unavailable";
  backend_type: "docker" | "docker+sysbox" | "qemu";
  capabilities: string[];
}

export class SandboxPlaneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPlaneUnavailableError";
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
