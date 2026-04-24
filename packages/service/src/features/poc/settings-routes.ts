/**
 * POC Settings routes — DeVeye config, defaults, timeout.
 */

import { Hono } from "hono";
import { requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { WebSocket } from "ws";
import * as pocStorage from "./storage.js";
import { logger } from "../../infra/logger.js";

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

// POST /api/settings/poc/test — test DeVeye connection
pocSettingsRouter.post("/poc/test", async (c) => {
  const body = await c.req.json<{ server_url?: string; token?: string }>().catch(() => ({} as { server_url?: string; token?: string }));

  // Use provided values or fall back to saved settings
  const saved = await pocStorage.getPocSettings();
  const serverUrl = body.server_url || saved?.deveye_server_url;
  const token = body.token || saved?.deveye_token;

  if (!serverUrl) {
    return c.json({ ok: false, error: "DeVeye Server URL not configured" });
  }

  // Test connection via WebSocket ping
  try {
    const result = await new Promise<{ ok: boolean; server_version?: string; error?: string }>(
      (resolve) => {
        const timeout = setTimeout(() => {
          ws.close();
          resolve({ ok: false, error: `Connection timeout (5s) at ${serverUrl}` });
        }, 5000);

        const headers: Record<string, string> = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        const ws = new WebSocket(serverUrl, { headers });

        ws.on("open", () => {
          // Send a ping/handshake message
          ws.send(JSON.stringify({ type: "ping" }));
          // If connection opens, server is reachable
          clearTimeout(timeout);
          ws.close();
          resolve({ ok: true, server_version: "connected" });
        });

        ws.on("error", (err) => {
          clearTimeout(timeout);
          resolve({ ok: false, error: `${err.message} at ${serverUrl}` });
        });
      },
    );

    logger.info({ serverUrl, ok: result.ok }, "DeVeye connection test");
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: String(err) });
  }
});
