import { getDb } from "../../infra/db/client.js";
import type { QueryContext } from "../../infra/query-context.js";
import { shouldFilterByUser } from "../../infra/query-context.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

interface DashboardData {
  range: string;
  stats: {
    total_scans: { value: number; delta: string };
    vulnerabilities: { value: number; delta: string };
    avg_duration_min: { value: number; delta: string };
    total_tokens: { value: number; delta: string };
  };
  severity_dist: { high: number; medium: number; low: number; info: number };
  review_status_dist: { pending: number; confirmed: number; false_positive: number; ignored: number };
  vulnerability_type_top5: { vuln_type: string; count: number }[];
  recent_scans: {
    id: string;
    project_name: string;
    state: string;
    severity_counts: { h: number; m: number; l: number; i: number };
    risk_score: number | null;
    duration_ms: number | null;
    created_at: Date;
  }[];
}

const cache = new Map<string, { data: DashboardData; computedAt: number }>();

export async function getDashboard(range?: "30d" | "90d" | "all"): Promise<DashboardData>;
export async function getDashboard(ctx: QueryContext, range?: "30d" | "90d" | "all", filterUserId?: string): Promise<DashboardData>;
export async function getDashboard(
  a: QueryContext | "30d" | "90d" | "all" = "30d",
  b: "30d" | "90d" | "all" = "30d",
  filterUserId?: string,
): Promise<DashboardData> {
  const hasCtx = typeof a !== "string";
  const ctx = hasCtx ? a : undefined;
  const range = hasCtx ? b : a;
  const tenantId = ctx?.tenantId ?? DEFAULT_TENANT_ID;
  const effectiveUserId = ctx && shouldFilterByUser(ctx) ? ctx.userId : filterUserId;
  const cacheKey = `${tenantId}:${effectiveUserId ?? "all"}:${range}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await computeDashboard(tenantId, effectiveUserId, range);
  cache.set(cacheKey, { data, computedAt: Date.now() });
  return data;
}

export function invalidateDashboardCache(): void {
  cache.clear();
}

async function computeDashboard(tenantId: string, userId: string | undefined, range: string): Promise<DashboardData> {
  const db = getDb();

  const since =
    range === "30d"
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      : range === "90d"
        ? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        : new Date(0);

  const scansRows = userId
    ? await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${userId} AND state = 'completed'
        AND created_at >= ${since}
    `
    : await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${tenantId} AND state = 'completed'
        AND created_at >= ${since}
    `;

  // Active vulns = pending + confirmed (exclude false_positive / ignored) — VULNHUN-153
  const sevRows = userId
    ? await db<{ severity: string; count: string }[]>`
      SELECT f.severity, COUNT(*) as count FROM findings_meta f
      JOIN tasks t ON t.id = f.task_id
      WHERE f.tenant_id = ${tenantId} AND t.created_by = ${userId}
        AND f.item_type = 'finding'
        AND f.indexed_at >= ${since}
        AND f.review_status IN ('pending', 'confirmed')
      GROUP BY f.severity
    `
    : await db<{ severity: string; count: string }[]>`
      SELECT severity, COUNT(*) as count FROM findings_meta
      WHERE tenant_id = ${tenantId}
        AND item_type = 'finding'
        AND indexed_at >= ${since}
        AND review_status IN ('pending', 'confirmed')
      GROUP BY severity
    `;

  const vulnTypeRows = userId
    ? await db<{ vuln_type: string; count: string }[]>`
      SELECT vuln_type, COUNT(*) as count FROM (
        SELECT COALESCE(NULLIF(f.vuln_type_full, ''), NULLIF(f.vuln_type, '')) as vuln_type
        FROM findings_meta f
        JOIN tasks t ON t.id = f.task_id
        WHERE f.tenant_id = ${tenantId} AND t.created_by = ${userId}
          AND f.item_type = 'finding'
          AND f.indexed_at >= ${since}
          AND f.review_status IN ('pending', 'confirmed')
          AND COALESCE(NULLIF(f.vuln_type_full, ''), NULLIF(f.vuln_type, '')) IS NOT NULL
      ) x
      GROUP BY vuln_type
      ORDER BY count DESC
      LIMIT 5
    `
    : await db<{ vuln_type: string; count: string }[]>`
      SELECT vuln_type, COUNT(*) as count FROM (
        SELECT COALESCE(NULLIF(vuln_type_full, ''), NULLIF(vuln_type, '')) as vuln_type
        FROM findings_meta
        WHERE tenant_id = ${tenantId}
          AND item_type = 'finding'
          AND indexed_at >= ${since}
          AND review_status IN ('pending', 'confirmed')
          AND COALESCE(NULLIF(vuln_type_full, ''), NULLIF(vuln_type, '')) IS NOT NULL
      ) x
      GROUP BY vuln_type
      ORDER BY count DESC
      LIMIT 5
    `;

  const recentRows = userId
    ? await db<{ id: string; project_name: string; state: string; risk_score: number | null; duration_ms: number | null; created_at: Date }[]>`
      SELECT id, project_name, state, risk_score, duration_ms, created_at
      FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${userId}
      ORDER BY created_at DESC LIMIT 5
    `
    : await db<{ id: string; project_name: string; state: string; risk_score: number | null; duration_ms: number | null; created_at: Date }[]>`
      SELECT id, project_name, state, risk_score, duration_ms, created_at
      FROM tasks
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC LIMIT 5
    `;

  const durationRows = userId
    ? await db<{ avg_duration: string | null }[]>`
      SELECT AVG(duration_ms) as avg_duration FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${userId} AND state = 'completed'
        AND created_at >= ${since}
    `
    : await db<{ avg_duration: string | null }[]>`
      SELECT AVG(duration_ms) as avg_duration FROM tasks
      WHERE tenant_id = ${tenantId} AND state = 'completed'
        AND created_at >= ${since}
    `;

  const totalScans = Number(scansRows[0]?.count ?? 0);
  const avgDurationMs = Number(durationRows[0]?.avg_duration ?? 0);
  const avgDurationMin = Math.round(avgDurationMs / 60_000 * 10) / 10;

  // Total token usage across completed scans in range (sum of per-task total_tokens).
  // Count tokens from any finished task that recorded usage (completed + failed).
  const tokenRows = userId
    ? await db<{ total: string | null }[]>`
      SELECT COALESCE(SUM(total_tokens), 0) as total FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${userId}
        AND state IN ('completed', 'failed', 'cancelled')
        AND created_at >= ${since}
    `
    : await db<{ total: string | null }[]>`
      SELECT COALESCE(SUM(total_tokens), 0) as total FROM tasks
      WHERE tenant_id = ${tenantId}
        AND state IN ('completed', 'failed', 'cancelled')
        AND created_at >= ${since}
    `;
  const totalTokens = Number(tokenRows[0]?.total ?? 0);

  const severityDist = { high: 0, medium: 0, low: 0, info: 0 };
  let totalVulns = 0;
  for (const r of sevRows) {
    const s = r.severity as keyof typeof severityDist;
    if (s in severityDist) {
      severityDist[s] = Number(r.count);
      totalVulns += Number(r.count);
    }
  }

  const reviewRows = userId
    ? await db<{ review_status: string; count: string }[]>`
      SELECT f.review_status, COUNT(*) as count FROM findings_meta f
      JOIN tasks t ON t.id = f.task_id
      WHERE f.tenant_id = ${tenantId} AND t.created_by = ${userId}
      GROUP BY f.review_status
    `
    : await db<{ review_status: string; count: string }[]>`
      SELECT review_status, COUNT(*) as count FROM findings_meta
      WHERE tenant_id = ${tenantId}
      GROUP BY review_status
    `;
  const reviewStatusDist = { pending: 0, confirmed: 0, false_positive: 0, ignored: 0 };
  for (const r of reviewRows) {
    const s = r.review_status as keyof typeof reviewStatusDist;
    if (s in reviewStatusDist) reviewStatusDist[s] = Number(r.count);
  }

  const recentWithCounts = await Promise.all(
    recentRows.map(async (task) => {
      const rows = await db<{ severity: string; count: string }[]>`
        SELECT severity, COUNT(*) as count FROM findings_meta
        WHERE task_id = ${task.id} AND item_type = 'finding'
          AND review_status IN ('pending', 'confirmed')
        GROUP BY severity
      `;
      const counts = { h: 0, m: 0, l: 0, i: 0 };
      for (const r of rows) {
        if (r.severity === "high") counts.h = Number(r.count);
        else if (r.severity === "medium") counts.m = Number(r.count);
        else if (r.severity === "low") counts.l = Number(r.count);
        else if (r.severity === "info") counts.i = Number(r.count);
      }
      return { ...task, severity_counts: counts };
    }),
  );

  const deltas = await computeDeltas(tenantId, userId, range, since, totalScans, totalVulns, avgDurationMin);

  return {
    range,
    stats: {
      total_scans: { value: totalScans, delta: deltas.scans },
      vulnerabilities: { value: totalVulns, delta: deltas.vulns },
      avg_duration_min: { value: avgDurationMin, delta: deltas.duration },
      total_tokens: { value: totalTokens, delta: "" },
    },
    severity_dist: severityDist,
    review_status_dist: reviewStatusDist,
    vulnerability_type_top5: vulnTypeRows.map((r) => ({ vuln_type: r.vuln_type, count: Number(r.count) })),
    recent_scans: recentWithCounts,
  };
}

async function computeDeltas(
  tenantId: string,
  userId: string | undefined,
  range: string,
  since: Date,
  currentScans: number,
  currentVulns: number,
  currentAvgMin: number,
): Promise<{ scans: string; vulns: string; duration: string }> {
  const db = getDb();
  if (range === "all") return { scans: "", vulns: "", duration: "" };

  const periodMs = range === "30d" ? 30 * 86400_000 : 90 * 86400_000;
  const prevSince = new Date(since.getTime() - periodMs);

  const prevScansRows = userId
    ? await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${userId} AND state = 'completed'
        AND created_at >= ${prevSince} AND created_at < ${since}
    `
    : await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${tenantId} AND state = 'completed'
        AND created_at >= ${prevSince} AND created_at < ${since}
    `;
  const prevVulnsRows = userId
    ? await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM findings_meta f
      JOIN tasks t ON t.id = f.task_id
      WHERE f.tenant_id = ${tenantId} AND t.created_by = ${userId}
        AND f.item_type = 'finding'
        AND f.review_status IN ('pending', 'confirmed')
        AND f.indexed_at >= ${prevSince} AND f.indexed_at < ${since}
    `
    : await db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM findings_meta
      WHERE tenant_id = ${tenantId}
        AND item_type = 'finding'
        AND review_status IN ('pending', 'confirmed')
        AND indexed_at >= ${prevSince} AND indexed_at < ${since}
    `;
  const prevDurRows = userId
    ? await db<{ avg_duration: string | null }[]>`
      SELECT AVG(duration_ms) as avg_duration FROM tasks
      WHERE tenant_id = ${tenantId} AND created_by = ${userId} AND state = 'completed'
        AND created_at >= ${prevSince} AND created_at < ${since}
    `
    : await db<{ avg_duration: string | null }[]>`
      SELECT AVG(duration_ms) as avg_duration FROM tasks
      WHERE tenant_id = ${tenantId} AND state = 'completed'
        AND created_at >= ${prevSince} AND created_at < ${since}
    `;

  const prevScans = Number(prevScansRows[0]?.count ?? 0);
  const prevVulns = Number(prevVulnsRows[0]?.count ?? 0);
  const prevAvgMin = Math.round(Number(prevDurRows[0]?.avg_duration ?? 0) / 60_000 * 10) / 10;

  return {
    scans: formatDelta(currentScans, prevScans),
    vulns: formatDelta(currentVulns, prevVulns),
    duration: formatDelta(currentAvgMin, prevAvgMin),
  };
}

function formatDelta(current: number, previous: number): string {
  if (previous === 0 && current === 0) return "";
  // No prior baseline — show absolute total, not "+∞" (VULNHUN-162).
  if (previous === 0) return current > 0 ? `总计 ${current}` : "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "0%";
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}
