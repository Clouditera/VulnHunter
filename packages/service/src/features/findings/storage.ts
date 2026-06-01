import { getDb } from "../../infra/db/client.js";
import type { Severity, FindingReviewStatus } from "@vulnagent/shared";
import { FINDING_REVIEW_STATUSES } from "@vulnagent/shared";

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
  review_status: FindingReviewStatus;
  reviewed_by: string | null;
  reviewed_at: Date | null;
}

export interface DbFindingReviewEvent {
  id: string;
  task_id: string;
  finding_key: string;
  user_id: string;
  user_email: string;
  user_display_name: string;
  old_status: FindingReviewStatus;
  new_status: FindingReviewStatus;
  note: string | null;
  created_at: Date;
}

export function isFindingReviewStatus(value: unknown): value is FindingReviewStatus {
  return typeof value === "string" && FINDING_REVIEW_STATUSES.includes(value as FindingReviewStatus);
}

export async function listFindings(params: {
  taskId: string;
  severity?: Severity;
  reviewStatuses?: FindingReviewStatus[];
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<DbFindingMeta[]> {
  const db = getDb();
  const limit = Math.min(params.limit ?? 500, 1000);
  const offset = params.offset ?? 0;

  // Build dynamic WHERE conditions
  const conditions: ReturnType<typeof db>[] = [];
  conditions.push(db`task_id = ${params.taskId} AND tenant_id = ${DEFAULT_TENANT_ID}`);

  if (params.severity) {
    conditions.push(db`severity = ${params.severity}`);
  }
  if (params.reviewStatuses && params.reviewStatuses.length > 0) {
    conditions.push(db`review_status = ANY(${params.reviewStatuses})`);
  }
  if (params.search) {
    const pattern = "%" + params.search + "%";
    conditions.push(db`(finding_key ILIKE ${pattern} OR primary_file ILIKE ${pattern})`);
  }

  const where = conditions.reduce((acc, cond, i) => i === 0 ? cond : db`${acc} AND ${cond}`);

  return db<DbFindingMeta[]>`
    SELECT * FROM findings_meta
    WHERE ${where}
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

export async function setFindingReviewStatus(params: {
  taskId: string;
  findingKey: string;
  userId: string;
  reviewStatus: FindingReviewStatus;
  note?: string;
}): Promise<{ finding: DbFindingMeta; event: DbFindingReviewEvent }> {
  const db = getDb();

  return db.begin(async (tx) => {
    // Lock + read current state
    const [current] = await tx<DbFindingMeta[]>`
      SELECT * FROM findings_meta
      WHERE task_id = ${params.taskId} AND finding_key = ${params.findingKey}
        AND tenant_id = ${DEFAULT_TENANT_ID}
      FOR UPDATE
    `;
    if (!current) throw Object.assign(new Error("Finding not found"), { code: "ERR_NOT_FOUND" });

    const oldStatus = current.review_status;
    const now = new Date();

    // Update current state
    const [updated] = await tx<DbFindingMeta[]>`
      UPDATE findings_meta SET
        review_status = ${params.reviewStatus},
        reviewed_by = ${params.userId},
        reviewed_at = ${now}
      WHERE id = ${current.id}
      RETURNING *
    `;

    // Insert audit event
    const [event] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO finding_review_events
        (tenant_id, task_id, finding_id, finding_key, user_id, old_status, new_status, note)
      VALUES (
        ${DEFAULT_TENANT_ID}, ${params.taskId}, ${current.id},
        ${params.findingKey}, ${params.userId}, ${oldStatus}, ${params.reviewStatus},
        ${params.note ?? null}
      )
      RETURNING id, created_at
    `;

    // Get user info for event response
    const [user] = await tx<{ email: string; display_name: string | null }[]>`
      SELECT email, display_name FROM users WHERE id = ${params.userId}
    `;

    const reviewEvent: DbFindingReviewEvent = {
      id: event.id,
      task_id: params.taskId,
      finding_key: params.findingKey,
      user_id: params.userId,
      user_email: user?.email ?? "",
      user_display_name: user?.display_name ?? user?.email ?? "",
      old_status: oldStatus,
      new_status: params.reviewStatus,
      note: params.note ?? null,
      created_at: event.created_at,
    };

    return { finding: updated, event: reviewEvent };
  });
}

export async function bulkSetFindingReviewStatus(params: {
  taskId: string;
  findingKeys: string[];
  userId: string;
  reviewStatus: FindingReviewStatus;
  note?: string;
}): Promise<{ updated: number; findings: DbFindingMeta[] }> {
  const db = getDb();
  if (params.findingKeys.length > 500) {
    throw Object.assign(new Error("Max 500 findings per bulk operation"), { code: "ERR_VALIDATION" });
  }

  return db.begin(async (tx) => {
    const now = new Date();

    // Get current states for all findings
    const findings = await tx<DbFindingMeta[]>`
      SELECT * FROM findings_meta
      WHERE task_id = ${params.taskId}
        AND finding_key = ANY(${params.findingKeys})
        AND tenant_id = ${DEFAULT_TENANT_ID}
      FOR UPDATE
    `;

    if (findings.length === 0) return { updated: 0, findings: [] };

    // Update all
    const ids = findings.map((f) => f.id);
    const updated = await tx<DbFindingMeta[]>`
      UPDATE findings_meta SET
        review_status = ${params.reviewStatus},
        reviewed_by = ${params.userId},
        reviewed_at = ${now}
      WHERE id = ANY(${ids})
      RETURNING *
    `;

    // Insert audit events for each
    for (const f of findings) {
      await tx`
        INSERT INTO finding_review_events
          (tenant_id, task_id, finding_id, finding_key, user_id, old_status, new_status, note)
        VALUES (
          ${DEFAULT_TENANT_ID}, ${params.taskId}, ${f.id},
          ${f.finding_key}, ${params.userId}, ${f.review_status}, ${params.reviewStatus},
          ${params.note ?? null}
        )
      `;
    }

    return { updated: updated.length, findings: updated };
  });
}

export async function listFindingReviewEvents(
  taskId: string,
  findingKey: string,
): Promise<DbFindingReviewEvent[]> {
  const db = getDb();
  return db<DbFindingReviewEvent[]>`
    SELECT e.id, e.task_id, e.finding_key, e.user_id,
           u.email AS user_email,
           COALESCE(u.display_name, u.email) AS user_display_name,
           e.old_status, e.new_status, e.note, e.created_at
    FROM finding_review_events e
    JOIN users u ON u.id = e.user_id
    WHERE e.task_id = ${taskId} AND e.finding_key = ${findingKey}
    ORDER BY e.created_at DESC
  `;
}

export async function countFindingsByReviewStatus(
  taskId?: string,
): Promise<Record<FindingReviewStatus, number>> {
  const db = getDb();
  const rows = taskId
    ? await db<{ review_status: FindingReviewStatus; count: string }[]>`
        SELECT review_status, COUNT(*) as count FROM findings_meta
        WHERE task_id = ${taskId} AND tenant_id = ${DEFAULT_TENANT_ID}
        GROUP BY review_status
      `
    : await db<{ review_status: FindingReviewStatus; count: string }[]>`
        SELECT review_status, COUNT(*) as count FROM findings_meta
        WHERE tenant_id = ${DEFAULT_TENANT_ID}
        GROUP BY review_status
      `;

  const counts: Record<FindingReviewStatus, number> = {
    pending: 0, confirmed: 0, false_positive: 0, ignored: 0,
  };
  for (const r of rows) counts[r.review_status] = Number(r.count);
  return counts;
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
