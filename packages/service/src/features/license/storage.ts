import { getDb } from "../../infra/db/client.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface DbLicense {
  id: string;
  cert_raw: string;
  machine_code: string;
  expires_at: Date;
  activated_at: Date;
  last_seen_at: Date;
}

export function getOrCreateInstallationId(dataDir: string): string {
  const filePath = join(dataDir, ".install_id");
  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf-8").trim();
  }
  mkdirSync(dataDir, { recursive: true });
  const id = randomUUID();
  writeFileSync(filePath, id, { mode: 0o644 });
  return id;
}

export async function getActiveLicense(): Promise<DbLicense | null> {
  const db = getDb();
  const rows = await db<DbLicense[]>`
    SELECT id, cert_raw, machine_code, expires_at, activated_at, last_seen_at
    FROM licenses
    ORDER BY activated_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function saveLicense(params: {
  certRaw: string;
  machineCode: string;
  expiresAt: Date;
}): Promise<void> {
  const db = getDb();
  // Keep only one license record (replace)
  await db.begin(async (tx) => {
    await tx`DELETE FROM licenses`;
    await tx`
      INSERT INTO licenses (cert_raw, machine_code, expires_at)
      VALUES (${params.certRaw}, ${params.machineCode}, ${params.expiresAt})
    `;
  });
}

export async function updateLastSeen(): Promise<void> {
  const db = getDb();
  await db`UPDATE licenses SET last_seen_at = now()`;
}
