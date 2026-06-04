import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getDashboard } from "./service.js";
import { queryContextFromUser } from "../../infra/query-context.js";

export const dashboardRouter = new Hono();
dashboardRouter.use("*", licenseGuard);
dashboardRouter.use("*", requireAuth);

dashboardRouter.get("/", async (c) => {
  const range = (c.req.query("range") ?? "30d") as "30d" | "90d" | "all";
  const ctx = queryContextFromUser(c.get("user"));
  const filterUserId = ctx.role === "admin" ? c.req.query("user_id") : undefined;
  const data = await getDashboard(ctx, range, filterUserId);
  return c.json(data);
});
