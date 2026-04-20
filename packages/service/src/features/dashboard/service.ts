import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

interface DashboardData {
  range: string;
  stats: {
    total_scans: { value: number; delta: string };
    vulnerabilities: { value: number; delta: string };
    avg_duration_min: { value: number; delta: string };
  };
  severity_dist: { high: number; medium: number; low: number; info: number };
  cwe_top5: { cwe: string | null; count: number }[];
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

export async function getDashboard(range: "30d" | "90d" | "all" = "30d"): Promise<DashboardData> {
  const cacheKey = `${DEFAULT_TENANT_ID}:${range}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const data = await computeDashboard(range);
  cache.set(cacheKey, { data, computedAt: Date.now() });
  return data;
}

export function invalidateDashboardCache(): void {
  cache.clear();
}

async function computeDashboard(range: string): Promise<DashboardData> {
  const db = getDb();

  const since =
    range === "30d"
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      : range === "90d"
        ? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        : new Date(0);

  const [scansRows, sevRows, cweRows, recentRows, durationRows] = await Promise.all([
    // Total scans
    db<{ count: string }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE tenant_id = ${DEFAULT_TENANT_ID} AND state = 'completed'
        AND created_at >= ${since}
    `,
    // Severity distribution
    db<{ severity: string; count: string }[]>`
      SELECT severity, COUNT(*) as count FROM findings_meta
      WHERE tenant_id = ${DEFAULT_TENANT_ID}
        AND indexed_at >= ${since}
      GROUP BY severity
    `,
    // CWE Top 5
    db<{ cwe: string | null; count: string }[]>`
      SELECT cwe, COUNT(*) as count FROM findings_meta
      WHERE tenant_id = ${DEFAULT_TENANT_ID} AND cwe IS NOT NULL
        AND indexed_at >= ${since}
      GROUP BY cwe ORDER BY count DESC LIMIT 5
    `,
    // Recent scans
    db<{
      id: string;
      project_name: string;
      state: string;
      risk_score: number | null;
      duration_ms: number | null;
      created_at: Date;
    }[]>`
      SELECT id, project_name, state, risk_score, duration_ms, created_at
      FROM tasks
      WHERE tenant_id = ${DEFAULT_TENANT_ID}
      ORDER BY created_at DESC LIMIT 5
    `,
    // Avg duration
    db<{ avg_duration: string | null }[]>`
      SELECT AVG(duration_ms) as avg_duration FROM tasks
      WHERE tenant_id = ${DEFAULT_TENANT_ID} AND state = 'completed'
        AND created_at >= ${since}
    `,
  ]);

  const totalScans = Number(scansRows[0]?.count ?? 0);
  const avgDurationMs = Number(durationRows[0]?.avg_duration ?? 0);
  const avgDurationMin = Math.round(avgDurationMs / 60_000 * 10) / 10;

  const severityDist = { high: 0, medium: 0, low: 0, info: 0 };
  let totalVulns = 0;
  for (const r of sevRows) {
    const s = r.severity as keyof typeof severityDist;
    if (s in severityDist) {
      severityDist[s] = Number(r.count);
      totalVulns += Number(r.count);
    }
  }

  // Get severity counts per recent task
  const recentWithCounts = await Promise.all(
    recentRows.map(async (task) => {
      const rows = await db<{ severity: string; count: string }[]>`
        SELECT severity, COUNT(*) as count FROM findings_meta
        WHERE task_id = ${task.id} GROUP BY severity
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

  return {
    range,
    stats: {
      total_scans: { value: totalScans, delta: "" },
      vulnerabilities: { value: totalVulns, delta: "" },
      avg_duration_min: { value: avgDurationMin, delta: "" },
    },
    severity_dist: severityDist,
    cwe_top5: cweRows.map((r) => ({ cwe: r.cwe, count: Number(r.count) })),
    recent_scans: recentWithCounts,
  };
}
