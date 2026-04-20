/**
 * VulnHunt Service — entry point
 */

import { loadConfig } from "./infra/config.js";
import { initDb, runMigrations } from "./infra/db/index.js";
import { initMinio } from "./infra/minio/index.js";
import { logger } from "./infra/logger.js";
import { init as initLicense, tick as tickLicense } from "./features/license/index.js";
import { initDocker, TaskScheduler, reconcileWorkers } from "./features/workers/index.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info("VulnHunt Service starting...");

  // Initialize DB
  await initDb(config.db.url);
  await runMigrations();

  // Initialize MinIO
  await initMinio(config.minio).catch((err) => {
    logger.warn({ err }, "MinIO not available — continuing (workers will fail)");
  });

  // Initialize License
  initLicense(config.dataDir);

  // Initialize Docker
  initDocker(config.docker.socketPath);

  // Reconcile workers from previous run
  await reconcileWorkers().catch((err) =>
    logger.warn({ err }, "Reconciler failed — continuing"),
  );

  // Start task scheduler
  const scheduler = new TaskScheduler(config);
  await scheduler.start();

  // Start hourly license tick
  setInterval(() => {
    tickLicense().catch((err) => logger.error({ err }, "License tick failed"));
  }, 60 * 60 * 1000);

  // Graceful shutdown
  process.on("SIGTERM", () => {
    scheduler.stop();
    process.exit(0);
  });

  // Start HTTP server
  startServer(config.port);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
