/**
 * VulnHunt Service — entry point
 */

import { loadConfig } from "./infra/config.js";
import { initDb, runMigrations } from "./infra/db/index.js";
import { logger } from "./infra/logger.js";
import { init as initLicense, tick as tickLicense } from "./features/license/index.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info("VulnHunt Service starting...");

  // Initialize DB
  await initDb(config.db.url);
  await runMigrations();

  // Initialize License
  initLicense(config.dataDir);

  // Start hourly license tick
  setInterval(() => {
    tickLicense().catch((err) => logger.error({ err }, "License tick failed"));
  }, 60 * 60 * 1000);

  // Start HTTP server
  startServer(config.port);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
