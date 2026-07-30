import { isSandboxPlaneConfigured, listSandboxPlaneProfiles, SandboxPlaneUnavailableError } from "../sandbox-plane/client.js";
import { getDb } from "../../infra/db/client.js";
import { logger } from "../../infra/logger.js";

export interface SandboxCapacityView {
  available_now: boolean;
  running_sandboxes: number;
  queue_depth: number;
  /** ok | capacity_tight | not_configured (no plane env) | unavailable (plane down) */
  detail: "ok" | "capacity_tight" | "not_configured" | "unavailable";
  configured: boolean;
}

export async function getSandboxCapacityView(): Promise<SandboxCapacityView> {
  const db = getDb();
  const runningRows = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM task_sandboxes
    WHERE state = 'running'
  `;
  const running = Number(runningRows[0]?.count ?? 0);

  const queueRows = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM tasks
    WHERE state IN ('queued', 'preparing')
      AND (metadata #>> '{sandbox_alloc,next_attempt_at}') IS NOT NULL
      AND (metadata #>> '{sandbox_alloc,next_attempt_at}')::timestamptz > now()
  `;
  const queueDepth = Number(queueRows[0]?.count ?? 0);

  const configured = isSandboxPlaneConfigured();
  if (!configured) {
    return {
      available_now: false,
      running_sandboxes: running,
      queue_depth: queueDepth,
      detail: "not_configured",
      configured: false,
    };
  }

  let anyProfileAvailable = false;
  try {
    const profiles = await listSandboxPlaneProfiles();
    anyProfileAvailable = profiles.some((p) => p.status === "available");
  } catch (err) {
    logger.debug({ err }, "Sandbox capacity plane probe failed");
    const msg = err instanceof Error ? err.message : String(err);
    const notCfg = err instanceof SandboxPlaneUnavailableError && /not configured/i.test(msg);
    return {
      available_now: false,
      running_sandboxes: running,
      queue_depth: queueDepth,
      detail: notCfg ? "not_configured" : "unavailable",
      configured: !notCfg,
    };
  }

  const availableNow = anyProfileAvailable && queueDepth === 0;
  return {
    available_now: availableNow,
    running_sandboxes: running,
    queue_depth: queueDepth,
    detail: availableNow ? "ok" : "capacity_tight",
    configured: true,
  };
}

/** Derive sandbox_queue projection from task metadata (no DB schema change). */
export function projectSandboxQueue(metadata: unknown): {
  waiting: boolean;
  reason: "capacity" | "quota" | null;
  since: string | null;
  attempts: number;
} | null {
  if (!metadata || typeof metadata !== "object") return null;
  const alloc = (metadata as { sandbox_alloc?: Record<string, unknown> }).sandbox_alloc;
  if (!alloc || typeof alloc !== "object") return null;
  const next = typeof alloc.next_attempt_at === "string" ? alloc.next_attempt_at : null;
  if (!next) return null;
  const nextMs = Date.parse(next);
  const attempts = Number(alloc.attempts) || 0;
  const reason = alloc.last_error === "quota" ? "quota" as const : "capacity" as const;
  if (!Number.isFinite(nextMs) || nextMs <= Date.now()) {
    if (attempts > 0 && alloc.last_error) {
      return { waiting: true, reason, since: null, attempts };
    }
    return null;
  }
  return { waiting: true, reason, since: null, attempts };
}
