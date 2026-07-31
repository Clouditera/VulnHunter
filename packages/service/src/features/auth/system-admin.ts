/**
 * Deploy-provisioned singleton system admin.
 *
 * Env: VULNHUNTER_ADMIN_EMAIL + VULNHUNTER_ADMIN_PASSWORD
 * Missing either key → skip (legacy installs keep manual admins).
 * Every boot (idempotent): ensure one is_system admin with env password; demote others.
 */
import bcrypt from "bcrypt";
import { getDb } from "../../infra/db/client.js";
import { logger } from "../../infra/logger.js";
import * as storage from "./storage.js";

const BCRYPT_COST = 10;
const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export async function provisionSystemAdmin(): Promise<void> {
  const email = (process.env.VULNHUNTER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.VULNHUNTER_ADMIN_PASSWORD ?? "";

  if (!email || !password) {
    logger.info(
      "System admin provision skipped (set VULNHUNTER_ADMIN_EMAIL + VULNHUNTER_ADMIN_PASSWORD to enable)",
    );
    return;
  }
  if (password.length < 8) {
    logger.warn("System admin provision skipped: VULNHUNTER_ADMIN_PASSWORD must be ≥ 8 chars");
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const existing = await storage.findUserByEmail(email);

  if (existing) {
    await storage.updateUser(existing.id, {
      role: "admin",
      status: "active",
      passwordHash,
      mustChangePassword: false,
      // force is_system via dedicated path (updateUser allows isSystem for provision)
      isSystem: true,
    });
    logger.info({ email, userId: existing.id }, "System admin ensured (existing user)");
  } else {
    const created = await storage.createUser({
      email,
      passwordHash,
      role: "admin",
      displayName: "System Admin",
      mustChangePassword: false,
      source: "admin",
      isSystem: true,
    });
    logger.info({ email, userId: created.id }, "System admin created");
  }

  // Demote any other admin rows to member (singleton model).
  const db = getDb();
  const demoted = await db<{ id: string; email: string }[]>`
    UPDATE users
    SET role = 'member', updated_at = now()
    WHERE tenant_id = ${DEFAULT_TENANT_ID}
      AND role = 'admin'
      AND lower(email) <> ${email}
    RETURNING id, email
  `;
  for (const row of demoted) {
    logger.warn(
      { userId: row.id, email: row.email, systemAdminEmail: email },
      "Demoted non-system admin to member (singleton system admin)",
    );
  }
}
