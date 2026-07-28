/**
 * VulnHunter Service — entry point
 *
 * SERVICE_ROLE=business (default): full API + scheduler/workers
 * SERVICE_ROLE=admin: admin-api subset only (no docker/scheduler/migrations)
 */

import { loadConfig } from "./infra/config.js";
import { initDb, runMigrations } from "./infra/db/index.js";
import { initMinio } from "./infra/minio/index.js";
import { logger } from "./infra/logger.js";
import { initVault, checkCredentialHealth } from "./features/settings/index.js";
import { initDocker, TaskScheduler, reconcileWorkers } from "./features/workers/index.js";
import { initWorkerInstanceId } from "./features/workers/instance-id.js";
import { createApp, startServer, type ServiceRole } from "./server.js";
import { initInstallation } from "./features/system/index.js";

type EnterpriseModule = typeof import("@vulnhunter/enterprise");

function resolveServiceRole(): ServiceRole {
  const raw = (process.env.SERVICE_ROLE ?? "business").toLowerCase();
  return raw === "admin" ? "admin" : "business";
}

async function loadEnterpriseModule(): Promise<EnterpriseModule> {
  try {
    return await import("@vulnhunter/enterprise");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw err;
    const enterprisePath = "../../enterprise/dist/index.js";
    return await import(enterprisePath) as EnterpriseModule;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const role = resolveServiceRole();

  logger.info({ role }, "VulnHunter Service starting...");

  // DB always
  await initDb(config.db.url);

  if (role === "business") {
    // Schema migrations: business role is the single writer
    await runMigrations();
  }

  // Installation identity (both roles)
  initInstallation(config.dataDir);

  const app = createApp(role);
  let tickEnterpriseLicense: (() => Promise<void>) | null = null;
  if (config.edition === "enterprise") {
    try {
      const enterpriseModule = await loadEnterpriseModule();
      const enterprise = await enterpriseModule.initEnterprise(app, config, role);
      // Only business role runs the license tick timer
      if (role === "business") {
        tickEnterpriseLicense = enterprise.tickLicense;
      }
    } catch (err) {
      logger.warn({ err }, "Enterprise module not found — running community edition");
    }
  }

  // Vault needed by both (SMTP password decrypt on admin; credentials on business)
  initVault(config.dataDir);

  if (role === "admin") {
    // admin-api: no minio, no docker, no scheduler, no reconciler
    process.on("SIGTERM", () => process.exit(0));
    startServer(config.port, app);
    return;
  }

  // ── business-only infra ────────────────────────────────────────
  await initMinio(config.minio).catch((err) => {
    logger.warn({ err }, "MinIO not available — continuing (workers will fail)");
  });

  const credentialHealth = await checkCredentialHealth().catch((err) => {
    logger.warn({ err }, "Credential decrypt health check failed");
    return null;
  });
  if (credentialHealth?.keyUnavailable) {
    logger.warn(
      { total: credentialHealth.total },
      "Credential encryption key unavailable. Configure VULNHUNTER_MASTER_KEY_FILE; credential operations will fail until configured.",
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
      "Credential decrypt health degraded. Re-save credentials or restore the original master key file referenced by VULNHUNTER_MASTER_KEY_FILE.",
    );
  }

  initDocker(config.docker.socketPath);
  await initWorkerInstanceId();
  await reconcileWorkers().catch((err) =>
    logger.warn({ err }, "Reconciler failed — continuing"),
  );

  const scheduler = new TaskScheduler(config);
  await scheduler.start();

  if (tickEnterpriseLicense) {
    setInterval(() => {
      tickEnterpriseLicense?.().catch((err) => logger.error({ err }, "License tick failed"));
    }, 60 * 60 * 1000);
  }

  process.on("SIGTERM", () => {
    scheduler.stop();
    process.exit(0);
  });

  startServer(config.port, app);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
