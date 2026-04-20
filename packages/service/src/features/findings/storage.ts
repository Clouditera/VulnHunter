import { getDb } from "../../infra/db/client.js";
import type { Severity } from "@vulnhunt/shared";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbFindingMeta {
  id: string;
  task_id: string;
  finding_key: string;
  yaml_minio_key: string;
  severity: Severity;
  severity_numeric: number;
  vuln_type: string | null;
  vuln_type_full: string | null;
  cwe: string | null;
  primary_file: string | null;
  primary_line: number | null;
  function_name: string | null;
  language: string | null;
  group_id: string | null;
  user_verdict: string;
}

export async function listFindings(params: {
  taskId: string;
  severity?: Severity;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<DbFindingMeta[]> {
  const db = getDb();
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;

  if (params.severity && params.search) {
    return db<DbFindingMeta[]>`
      SELECT * FROM findings_meta
      WHERE task_id = ${params.taskId} AND tenant_id = ${DEFAULT_TENANT_ID}
        AND severity = ${params.severity}
        AND (finding_key ILIKE ${"%" + params.search + "%"}
             OR primary_file ILIKE ${"%" + params.search + "%"})
      ORDER BY severity_numeric DESC, finding_key
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (params.severity) {
    return db<DbFindingMeta[]>`
      SELECT * FROM findings_meta
      WHERE task_id = ${params.taskId} AND tenant_id = ${DEFAULT_TENANT_ID}
        AND severity = ${params.severity}
      ORDER BY severity_numeric DESC, finding_key
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (params.search) {
    return db<DbFindingMeta[]>`
      SELECT * FROM findings_meta
      WHERE task_id = ${params.taskId} AND tenant_id = ${DEFAULT_TENANT_ID}
        AND (finding_key ILIKE ${"%" + params.search + "%"}
             OR primary_file ILIKE ${"%" + params.search + "%"})
      ORDER BY severity_numeric DESC, finding_key
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return db<DbFindingMeta[]>`
    SELECT * FROM findings_meta
    WHERE task_id = ${params.taskId} AND tenant_id = ${DEFAULT_TENANT_ID}
    ORDER BY severity_numeric DESC, finding_key
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getFindingByKey(
  taskId: string,
  findingKey: string,
): Promise<DbFindingMeta | null> {
  const db = getDb();
  const rows = await db<DbFindingMeta[]>`
    SELECT * FROM findings_meta
    WHERE task_id = ${taskId} AND finding_key = ${findingKey} AND tenant_id = ${DEFAULT_TENANT_ID}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function countFindingsBySeverity(
  taskId: string,
): Promise<Record<Severity, number>> {
  const db = getDb();
  const rows = await db<{ severity: Severity; count: string }[]>`
    SELECT severity, COUNT(*) as count FROM findings_meta
    WHERE task_id = ${taskId} AND tenant_id = ${DEFAULT_TENANT_ID}
    GROUP BY severity
  `;
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const r of rows) counts[r.severity] = Number(r.count);
  return counts;
}
