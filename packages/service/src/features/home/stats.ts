import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CACHE_TTL_MS = 60_000;

export interface HomePublicStats {
  findings_total: number;
  /** High-severity findings (vulns, not risks) when classifiable */
  findings_high: number;
  tasks_completed: number;
  /** ISO timestamp of last aggregation */
  as_of: string;
}

let cache: { data: HomePublicStats; at: number } | null = null;

/**
 * Public marketing stats — aggregate only, no PII / no task details.
 * Omits scan-time averages and language-count marketing numbers per product decision.
 */
export async function getHomePublicStats(): Promise<HomePublicStats> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const db = getDb();
  const findings = await db<{ total: string; high: string }[]>`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (
        WHERE lower(coalesce(severity, '')) IN ('high', 'critical')
      )::text AS high
    FROM findings_meta
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
  `;
  const tasks = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM tasks
    WHERE tenant_id = ${DEFAULT_TENANT_ID} AND state = 'completed'
  `;

  const data: HomePublicStats = {
    findings_total: Number(findings[0]?.total ?? 0),
    findings_high: Number(findings[0]?.high ?? 0),
    tasks_completed: Number(tasks[0]?.count ?? 0),
    as_of: new Date().toISOString(),
  };
  cache = { data, at: Date.now() };
  return data;
}
