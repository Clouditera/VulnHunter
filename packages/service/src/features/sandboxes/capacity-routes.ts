import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { getSandboxCapacityView } from "./capacity.js";

export const sandboxCapacityRouter = new Hono();
sandboxCapacityRouter.use("*", licenseGuard);
sandboxCapacityRouter.use("*", requireAuth);

// GET /api/sandbox/capacity
sandboxCapacityRouter.get("/capacity", async (c) => {
  const view = await getSandboxCapacityView();
  return c.json(view);
});
