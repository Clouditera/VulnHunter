/**
 * POC Settings routes — DeVeye config, defaults, timeout.
 */

import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import * as pocStorage from "./storage.js";

export const pocSettingsRouter = new Hono();
pocSettingsRouter.use("*", licenseGuard);
pocSettingsRouter.use("*", requireAdmin);

// GET /api/settings/poc
pocSettingsRouter.get("/poc", async (c) => {
  const settings = await pocStorage.getPocSettings();
  return c.json({
    settings: settings ?? {
      default_target_mode: "provided",
      default_browser_tool: "deveye",
      deveye_server_url: null,
      deveye_token: null,
      default_concurrency: 1,
      poc_timeout_s: 1800,
    },
  });
});

// PATCH /api/settings/poc
pocSettingsRouter.patch("/poc", async (c) => {
  const body = await c.req.json<{
    default_target_mode?: string;
    default_browser_tool?: string;
    deveye_server_url?: string;
    deveye_token?: string;
    default_concurrency?: number;
    poc_timeout_s?: number;
  }>();

  const settings = await pocStorage.upsertPocSettings({
    defaultTargetMode: body.default_target_mode,
    defaultBrowserTool: body.default_browser_tool,
    deveyeServerUrl: body.deveye_server_url,
    deveyeToken: body.deveye_token,
    defaultConcurrency: body.default_concurrency,
    pocTimeoutS: body.poc_timeout_s,
  });

  return c.json({ settings });
});
