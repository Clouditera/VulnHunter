import { randomUUID } from "node:crypto";
import { getDb } from "../../infra/db/index.js";
import { logger } from "../../infra/logger.js";

/**
 * Stable per-install instance identity. Resolution order:
 * 1. VULNAGENT_INSTANCE_ID env override (explicit operator control).
 * 2. Persisted DB row (worker_instance, id=1) — created on first boot.
 *
 * Used to label every worker container with vulnagent.instance=<id> so a
 * reconciler / event subscription on a shared Docker daemon only ever
 * discovers containers spawned by THIS install, never a sibling install's
 * (2026-07-18 near-miss: an unscoped reconciler force-removed another
 * install's live scan container as a false "orphan").
 */

let workerInstanceId = "";

export async function initWorkerInstanceId(): Promise<string> {
  const override = process.env.VULNAGENT_INSTANCE_ID?.trim();
  if (override) {
    workerInstanceId = override;
    logger.info({ instanceId: workerInstanceId, source: "env" }, "Worker instance identity resolved");
    return workerInstanceId;
  }

  const db = getDb();
  const existing = await db<{ instance_id: string }[]>`
    SELECT instance_id FROM worker_instance WHERE id = 1
  `;
  if (existing[0]) {
    workerInstanceId = existing[0].instance_id;
    logger.info({ instanceId: workerInstanceId, source: "db" }, "Worker instance identity resolved");
    return workerInstanceId;
  }

  // Migration 029 seeds this row unconditionally, but guard against a
  // pre-migration read race / manual row deletion by creating one here too.
  const generated = randomUUID();
  await db`
    INSERT INTO worker_instance (id, instance_id) VALUES (1, ${generated})
    ON CONFLICT (id) DO NOTHING
  `;
  const row = await db<{ instance_id: string }[]>`
    SELECT instance_id FROM worker_instance WHERE id = 1
  `;
  workerInstanceId = row[0]?.instance_id ?? generated;
  logger.info({ instanceId: workerInstanceId, source: "db-created" }, "Worker instance identity resolved");
  return workerInstanceId;
}

export function getWorkerInstanceId(): string {
  if (!workerInstanceId) {
    throw new Error("Worker instance ID not initialized — call initWorkerInstanceId() first");
  }
  return workerInstanceId;
}
