import { getDb } from "../../infra/db/client.js";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface DbFeedback {
  id: string;
  tenant_id: string;
  user_id: string | null;
  satisfaction: number;
  content: string;
  contact_email: string | null;
  created_at: Date;
  // joined
  user_email?: string | null;
  user_display_name?: string | null;
}

export async function createFeedback(params: {
  userId: string | null;
  satisfaction: number;
  content: string;
  contactEmail?: string | null;
  tenantId?: string;
}): Promise<DbFeedback> {
  const db = getDb();
  const rows = await db<DbFeedback[]>`
    INSERT INTO user_feedback (tenant_id, user_id, satisfaction, content, contact_email)
    VALUES (
      ${params.tenantId ?? DEFAULT_TENANT_ID},
      ${params.userId},
      ${params.satisfaction},
      ${params.content},
      ${params.contactEmail ?? null}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function listFeedback(params?: {
  limit?: number;
  offset?: number;
  tenantId?: string;
}): Promise<{ items: DbFeedback[]; total: number }> {
  const db = getDb();
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 200);
  const offset = Math.max(params?.offset ?? 0, 0);
  const tenantId = params?.tenantId ?? DEFAULT_TENANT_ID;

  const totalRows = await db<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM user_feedback WHERE tenant_id = ${tenantId}
  `;
  const items = await db<DbFeedback[]>`
    SELECT f.*, u.email AS user_email, u.display_name AS user_display_name
    FROM user_feedback f
    LEFT JOIN users u ON u.id = f.user_id
    WHERE f.tenant_id = ${tenantId}
    ORDER BY f.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return { items, total: Number(totalRows[0]?.count ?? 0) };
}
