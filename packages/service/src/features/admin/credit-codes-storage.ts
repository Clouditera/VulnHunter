import { getDb } from "../../infra/db/client.js";

export type CreditCodeStatus = "available" | "assigned";

export interface DbCreditCode {
  id: string;
  code: string;
  status: CreditCodeStatus;
  assigned_user_id: string | null;
  assigned_at: Date | null;
  created_at: Date;
  assigned_user_email?: string | null;
}

const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_LINES = 5000;
const MAX_CODE_LEN = 128;

export function parseCreditCodeImport(text: string): {
  codes: string[];
  invalid: number;
  invalid_samples: string[];
} {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) {
    throw new Error("import_too_large");
  }
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_IMPORT_LINES) {
    throw new Error("import_too_many_lines");
  }

  const seen = new Set<string>();
  const codes: string[] = [];
  let invalid = 0;
  const invalid_samples: string[] = [];

  for (const raw of lines) {
    const code = raw.trim();
    if (!code) continue;
    if (/\s/.test(code) || code.length > MAX_CODE_LEN) {
      invalid += 1;
      if (invalid_samples.length < 5) invalid_samples.push(raw.slice(0, 200));
      continue;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  return { codes, invalid, invalid_samples };
}

export async function importCreditCodes(codes: string[]): Promise<{ inserted: number; skipped_duplicates: number }> {
  if (codes.length === 0) return { inserted: 0, skipped_duplicates: 0 };
  const db = getDb();
  let inserted = 0;
  // Batch insert with ON CONFLICT DO NOTHING
  for (const code of codes) {
    const rows = await db<{ id: string }[]>`
      INSERT INTO credit_codes (code)
      VALUES (${code})
      ON CONFLICT (code) DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) inserted += 1;
  }
  return { inserted, skipped_duplicates: codes.length - inserted };
}

export async function listCreditCodes(params: {
  status?: CreditCodeStatus;
  page: number;
  pageSize: number;
}): Promise<{
  items: DbCreditCode[];
  total: number;
  counts: { available: number; assigned: number };
}> {
  const db = getDb();
  const page = Math.max(params.page, 1);
  const pageSize = Math.min(Math.max(params.pageSize, 1), 100);
  const offset = (page - 1) * pageSize;
  const status = params.status;

  const countRows = await db<{ status: string; count: string }[]>`
    SELECT status, COUNT(*)::text AS count FROM credit_codes GROUP BY status
  `;
  const counts = { available: 0, assigned: 0 };
  for (const row of countRows) {
    if (row.status === "available") counts.available = Number(row.count);
    if (row.status === "assigned") counts.assigned = Number(row.count);
  }

  let total: number;
  let items: DbCreditCode[];
  if (status === "available" || status === "assigned") {
    const totalRows = await db<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM credit_codes WHERE status = ${status}
    `;
    total = Number(totalRows[0]?.count ?? 0);
    items = await db<DbCreditCode[]>`
      SELECT c.*, u.email AS assigned_user_email
      FROM credit_codes c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      WHERE c.status = ${status}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
  } else {
    total = counts.available + counts.assigned;
    items = await db<DbCreditCode[]>`
      SELECT c.*, u.email AS assigned_user_email
      FROM credit_codes c
      LEFT JOIN users u ON u.id = c.assigned_user_id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `;
  }

  return { items, total, counts };
}

export async function getCreditCodeById(id: string): Promise<DbCreditCode | null> {
  const db = getDb();
  const rows = await db<DbCreditCode[]>`
    SELECT * FROM credit_codes WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function deleteCreditCode(id: string): Promise<"ok" | "not_found" | "assigned"> {
  const row = await getCreditCodeById(id);
  if (!row) return "not_found";
  if (row.status === "assigned") return "assigned";
  const db = getDb();
  await db`DELETE FROM credit_codes WHERE id = ${id} AND status = 'available'`;
  return "ok";
}
