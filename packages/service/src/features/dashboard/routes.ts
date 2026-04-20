import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getDashboard } from "./service.js";

export const dashboardRouter = new Hono();
dashboardRouter.use("*", licenseGuard);
dashboardRouter.use("*", requireAuth);

dashboardRouter.get("/", async (c) => {
  const range = (c.req.query("range") ?? "30d") as "30d" | "90d" | "all";
  const data = await getDashboard(range);
  return c.json(data);
});
