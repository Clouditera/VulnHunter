/**
 * Report Skills + User Reports CRUD.
 * Tables `report_skills` and `user_reports` already exist (migration 002).
 * 037: owner_user_id; 039: skill_id nullable + ON DELETE SET NULL.
 */

import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

// ─── Report Skills ───

export interface DbReportSkill {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  minio_key: string;
  size_bytes: number;
  attachment_count: number;
  uploaded_by: string;
  owner_user_id: string | null;
  created_at: Date;
}

/** List skills owned by the user. Legacy owner=NULL rows stay hidden. */
export async function listSkills(ownerUserId: string): Promise<DbReportSkill[]> {
  const db = getDb();
  return db<DbReportSkill[]>`
    SELECT * FROM report_skills
    WHERE owner_user_id = ${ownerUserId}
    ORDER BY created_at DESC
  `;
}

export async function getSkill(id: string): Promise<DbReportSkill | null> {
  const db = getDb();
  const rows = await db<DbReportSkill[]>`
    SELECT * FROM report_skills WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/** Get skill only if owned by user (legacy/others → null, no existence leak). */
export async function getOwnedSkill(id: string, ownerUserId: string): Promise<DbReportSkill | null> {
  const db = getDb();
  const rows = await db<DbReportSkill[]>`
    SELECT * FROM report_skills
    WHERE id = ${id} AND owner_user_id = ${ownerUserId}
  `;
  return rows[0] ?? null;
}

export async function createSkill(params: {
  name: string;
  description?: string;
  minioKey: string;
  sizeBytes: number;
  attachmentCount?: number;
  uploadedBy: string;
  ownerUserId: string;
}): Promise<DbReportSkill> {
  const db = getDb();
  const rows = await db<DbReportSkill[]>`
    INSERT INTO report_skills (
      tenant_id, name, description, minio_key, size_bytes, attachment_count, uploaded_by, owner_user_id
    )
    VALUES (
      ${DEFAULT_TENANT_ID}, ${params.name}, ${params.description ?? ""},
      ${params.minioKey}, ${params.sizeBytes}, ${params.attachmentCount ?? 0},
      ${params.uploadedBy}, ${params.ownerUserId}
    )
    RETURNING *
  `;
  return rows[0];
}

/** Delete only if owned by user. Returns false when missing or not owned. */
export async function deleteOwnedSkill(id: string, ownerUserId: string): Promise<DbReportSkill | null> {
  const db = getDb();
  const rows = await db<DbReportSkill[]>`
    DELETE FROM report_skills
    WHERE id = ${id} AND owner_user_id = ${ownerUserId}
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ─── User Reports ───

export interface DbUserReport {
  id: string;
  tenant_id: string;
  task_id: string;
  skill_id: string | null;
  status: "generating" | "completed" | "failed";
  format: string | null;
  primary_minio_key: string | null;
  bundle_minio_key: string | null;
  events_minio_key: string | null;
  failure_reason: string | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration_ms: number | null;
}

export async function listReports(taskId: string): Promise<(DbUserReport & { skill_name?: string | null })[]> {
  const db = getDb();
  return db<(DbUserReport & { skill_name?: string | null })[]>`
    SELECT r.*, s.name AS skill_name
    FROM user_reports r
    LEFT JOIN report_skills s ON r.skill_id = s.id
    WHERE r.task_id = ${taskId}
    ORDER BY r.created_at DESC
  `;
}

export async function getReport(id: string): Promise<(DbUserReport & { skill_name?: string | null }) | null> {
  const db = getDb();
  const rows = await db<(DbUserReport & { skill_name?: string | null })[]>`
    SELECT r.*, s.name AS skill_name
    FROM user_reports r
    LEFT JOIN report_skills s ON r.skill_id = s.id
    WHERE r.id = ${id}
  `;
  return rows[0] ?? null;
}

export async function createReport(params: {
  taskId: string;
  skillId?: string | null;
  createdBy: string;
  credentialId?: string;
}): Promise<DbUserReport> {
  const db = getDb();
  const skillId = params.skillId ?? null;
  const rows = await db<DbUserReport[]>`
    INSERT INTO user_reports (tenant_id, task_id, skill_id, created_by, started_at)
    VALUES (${DEFAULT_TENANT_ID}, ${params.taskId}, ${skillId},
            ${params.createdBy}, ${new Date()})
    RETURNING *
  `;
  return rows[0];
}

export async function updateReportStatus(
  id: string,
  status: "completed" | "failed",
  extra?: {
    format?: string;
    primaryMinioKey?: string;
    bundleMinioKey?: string;
    failureReason?: string;
  },
): Promise<void> {
  const db = getDb();
  const completedAt = new Date();

  // Compute duration
  const report = await getReport(id);
  const durationMs = report?.started_at
    ? completedAt.getTime() - new Date(report.started_at).getTime()
    : null;

  await db`
    UPDATE user_reports
    SET status = ${status},
        format = ${extra?.format ?? null},
        primary_minio_key = ${extra?.primaryMinioKey ?? null},
        bundle_minio_key = ${extra?.bundleMinioKey ?? null},
        failure_reason = ${extra?.failureReason ?? null},
        completed_at = ${completedAt},
        duration_ms = ${durationMs}
    WHERE id = ${id}
  `;
}

export async function deleteReport(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db`DELETE FROM user_reports WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
