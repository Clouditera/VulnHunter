/**
 * VulnAgent Service — entry point
 */

import { loadConfig } from "./infra/config.js";
import { initDb, runMigrations } from "./infra/db/index.js";
import { initMinio } from "./infra/minio/index.js";
import { logger } from "./infra/logger.js";
import { initVault, checkCredentialHealth } from "./features/settings/index.js";
import { initDocker, TaskScheduler, reconcileWorkers } from "./features/workers/index.js";
import { initWorkerInstanceId } from "./features/workers/instance-id.js";
import { createApp, startServer } from "./server.js";
import { initInstallation } from "./features/system/index.js";

type EnterpriseModule = typeof import("@vulnagent/enterprise");

async function loadEnterpriseModule(): Promise<EnterpriseModule> {
  try {
    return await import("@vulnagent/enterprise");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    const enterprisePath = "../../enterprise/dist/index.js";
    return await import(enterprisePath) as EnterpriseModule;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info("VulnAgent Service starting...");

  // Initialize DB
  await initDb(config.db.url);
  await runMigrations();

  // Initialize MinIO
  await initMinio(config.minio).catch((err) => {
    logger.warn({ err }, "MinIO not available — continuing (workers will fail)");
  });

  // Initialize installation identity (community and enterprise both need it)
  initInstallation(config.dataDir);

  const app = createApp();
  let tickEnterpriseLicense: (() => Promise<void>) | null = null;
  if (config.edition === "enterprise") {
    try {
      const enterpriseModule = await loadEnterpriseModule();
      const enterprise = await enterpriseModule.initEnterprise(app, config);
      tickEnterpriseLicense = enterprise.tickLicense;
    } catch (err) {
      logger.warn({ err }, "Enterprise module not found — running community edition");
    }
  }

  // Initialize crypto vault
  initVault(config.dataDir);
  const credentialHealth = await checkCredentialHealth().catch((err) => {
    logger.warn({ err }, "Credential decrypt health check failed");
    return null;
  });
  if (credentialHealth?.keyUnavailable) {
    logger.warn(
      { total: credentialHealth.total },
      "Credential encryption key unavailable. Configure VULNAGENT_MASTER_KEY_FILE; credential operations will fail until configured.",
    );
  } else if (credentialHealth?.failed) {
    logger.error(
      {
        total: credentialHealth.total,
        ok: credentialHealth.ok,
        failed: credentialHealth.failed,
        currentKeyFingerprint: credentialHealth.currentKeyFingerprint,
        failedCredentials: credentialHealth.failedCredentials,
      },
      "Credential decrypt health degraded. Re-save credentials or restore the original master key file referenced by VULNAGENT_MASTER_KEY_FILE.",
    );
  }

  // Initialize Docker
  initDocker(config.docker.socketPath);

  // Resolve this install's stable instance identity — every worker
  // container is labeled with it so reconciliation on a shared Docker
  // daemon never touches a sibling install's containers.
  await initWorkerInstanceId();

  // Reconcile workers from previous run
  await reconcileWorkers().catch((err) =>
    logger.warn({ err }, "Reconciler failed — continuing"),
  );

  // Start task scheduler
  const scheduler = new TaskScheduler(config);
  await scheduler.start();

  if (tickEnterpriseLicense) {
    setInterval(() => {
      tickEnterpriseLicense?.().catch((err) => logger.error({ err }, "License tick failed"));
    }, 60 * 60 * 1000);
  }

  // Graceful shutdown
  process.on("SIGTERM", () => {
    scheduler.stop();
    process.exit(0);
  });

  // Start HTTP server
  startServer(config.port, app);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
