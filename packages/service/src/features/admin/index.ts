import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { adminUsersRouter } from "../auth/admin-users.js";
import { systemConfigRouter, smtpAdminRouter } from "./system-config-routes.js";
import { storageSweepRouter } from "./storage-sweep.js";

/** Wrap a sub-router with licenseGuard + requireAdmin (idempotent if child also guards). */
export function withAdminGuards(child: Hono): Hono {
  const h = new Hono();
  h.use("*", licenseGuard);
  h.use("*", requireAdmin);
  h.route("/", child);
  return h;
}

/**
 * Mount admin-api routes on the app as sibling prefixes (not one catch-all),
 * so enterprise can attach `/api/admin/users` after createApp without being swallowed.
 * SaaS-only: credit-codes + feedback admin mounted by @vulnhunter/saas (split A3).
 */
export function mountAdminRoutes(app: Hono, opts: { mountCommunityUsers: boolean }): void {
  app.route("/api/admin/system-config", withAdminGuards(systemConfigRouter));
  app.route("/api/admin/smtp", withAdminGuards(smtpAdminRouter));
  app.route("/api/admin/system/storage-sweep", withAdminGuards(storageSweepRouter));
  if (opts.mountCommunityUsers) {
    // adminUsersRouter already has licenseGuard + requireAdmin
    app.route("/api/admin/users", adminUsersRouter);
  }
}

export { systemConfigRouter, smtpAdminRouter } from "./system-config-routes.js";
export { storageSweepRouter } from "./storage-sweep.js";
