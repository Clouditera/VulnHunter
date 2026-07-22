import { getDb } from "../../infra/db/client.js";
import { listSandboxPlaneProfiles } from "../sandbox-plane/client.js";
import { logger } from "../../infra/logger.js";

export interface SandboxCapacityView {
  available_now: boolean;
  running_sandboxes: number;
  queue_depth: number;
  detail: "ok" | "capacity_tight";
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

  let anyProfileAvailable = true;
  try {
    const profiles = await listSandboxPlaneProfiles();
    anyProfileAvailable = profiles.some((p) => p.status === "available");
  } catch (err) {
    // Probe failure must not block the read surface; treat as ok (stale tip OK per contract).
    logger.debug({ err }, "Sandbox capacity plane probe failed; assuming available");
    anyProfileAvailable = true;
  }

  const availableNow = anyProfileAvailable && queueDepth === 0;
  return {
    available_now: availableNow,
    running_sandboxes: running,
    queue_depth: queueDepth,
    detail: availableNow ? "ok" : "capacity_tight",
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
