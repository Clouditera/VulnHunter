/**
 * Dynamic-verification route mounting (community removal, task-8a290a7d ①).
 *
 * The physical route implementations live in the sandbox modules — which
 * community does not carry. This module is the core-side mount point: when a
 * real dynamic provider is registered (enterprise/saas initEnterprise), the
 * business app mounts /api/sandbox/* (capacity router) and
 * /internal/sandbox-plane (apply endpoint). The modules themselves are
 * loaded via dynamic import so a community build with the modules physically
 * absent still compiles and boots (import never executed).
 *
 * In the private monorepo the sandboxes/sandbox-plane feature dirs will be
 * RE-HOMED under packages/enterprise — the import path below will be
 * redirected there in step ②. Core keeps this seam only.
 */

import type { Hono } from "hono";

export async function mountDynamicRoutes(app: Hono): Promise<void> {
  const [{ sandboxCapacityRouter }, { sandboxPlaneInternalRouter }] = await Promise.all([
    import("../sandboxes/capacity-routes.js"),
    import("../sandbox-plane/routes.js"),
  ]);
  app.route("/api/sandbox", sandboxCapacityRouter);
  app.route("/internal/sandbox-plane", sandboxPlaneInternalRouter);
}
