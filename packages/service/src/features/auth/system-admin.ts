/**
 * Deploy-provisioned bootstrap admin (seed-once, fish 2026-08-07).
 *
 * Env: VULNHUNTER_ADMIN_EMAIL + VULNHUNTER_ADMIN_PASSWORD
 * Consumed ONLY when the DB has no admin at all — seeds one is_system admin.
 * Once any admin exists (seeded or created via wizard), the env is permanently
 * ignored: DB is the single source of truth for admin credentials.
 *
 * Operational recovery: to re-seed from env, clear the admin row(s) and restart.
 */
import bcrypt from "bcrypt";
import { logger } from "../../infra/logger.js";
import * as storage from "./storage.js";

const BCRYPT_COST = 10;

export async function provisionSystemAdmin(): Promise<void> {
  const email = (process.env.VULNHUNTER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.VULNHUNTER_ADMIN_PASSWORD ?? "";

  if (!email || !password) {
    logger.info(
      "System admin provision skipped (set VULNHUNTER_ADMIN_EMAIL + VULNHUNTER_ADMIN_PASSWORD to enable)",
    );
    return;
  }

  // seed-once: if any admin already exists, env is permanently ignored.
  const hasAdmin = await storage.hasAnyAdmin();
  if (hasAdmin) {
    logger.info(
      { email },
      "System admin provision skipped: admin exists in DB, env credentials ignored (DB is authoritative)",
    );
    return;
  }

  if (password.length < 8) {
    logger.warn("System admin provision skipped: VULNHUNTER_ADMIN_PASSWORD must be ≥ 8 chars");
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const created = await storage.createUser({
    email,
    passwordHash,
    role: "admin",
    displayName: "System Admin",
    mustChangePassword: false,
    source: "admin",
    isSystem: true,
  });
  logger.info({ email, userId: created.id }, "System admin seeded (bootstrap, seed-once)");
}
