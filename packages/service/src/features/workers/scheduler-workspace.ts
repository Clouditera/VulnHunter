import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { removeWorkDir } from "./docker-client.js";

/**
 * Workspace-content dirs (canonical src + its backup) can contain files the
 * scan/prepare containers wrote as root — a bare rm then fails EACCES and
 * wedges 继续扫描 (31.106 TripStar, 2026-08-05). Route those removals through
 * removeWorkDir, which falls back to a root cleanup container. It never
 * throws (docker failure only warns), so control flow is unchanged.
 * Stage/prepare dirs are service-owned but get the same treatment for
 * uniformity.
 */
function cleanupImage(): string | undefined {
  return process.env.WORKER_IMAGE || undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertToken(token: string): void {
  if (!UUID_RE.test(token)) throw new Error("Invalid scheduler claim token");
}

export function getSchedulerPrepareDir(hostWorkDir: string, token: string): string {
  assertToken(token);
  return join(hostWorkDir, `.scheduler-prepare-${token}`);
}

export function getSchedulerBackupDir(hostWorkDir: string, token: string): string {
  assertToken(token);
  return join(hostWorkDir, `.scheduler-backup-${token}`);
}

export async function cleanupSchedulerWorkspace(hostWorkDir: string, token: string): Promise<void> {
  const canonicalSource = join(hostWorkDir, "src");
  const backupSource = getSchedulerBackupDir(hostWorkDir, token);
  if (existsSync(backupSource)) {
    if (!existsSync(canonicalSource)) await rename(backupSource, canonicalSource);
    else await removeWorkDir(backupSource, cleanupImage());
  }
  await removeWorkDir(getSchedulerPrepareDir(hostWorkDir, token), cleanupImage());
}

export async function publishSchedulerWorkspace(hostWorkDir: string, token: string): Promise<void> {
  const stageDir = getSchedulerPrepareDir(hostWorkDir, token);
  const stagedSource = join(stageDir, "src");
  const canonicalSource = join(hostWorkDir, "src");
  const backupSource = getSchedulerBackupDir(hostWorkDir, token);
  if (!existsSync(stagedSource)) throw new Error("Claim staging source is missing");
  await mkdir(hostWorkDir, { recursive: true });
  await removeWorkDir(backupSource, cleanupImage());
  let backedUp = false;
  if (existsSync(canonicalSource)) {
    await rename(canonicalSource, backupSource);
    backedUp = true;
  }
  try {
    await rename(stagedSource, canonicalSource);
    if (backedUp) await removeWorkDir(backupSource, cleanupImage());
  } catch (error) {
    if (existsSync(canonicalSource)) await removeWorkDir(canonicalSource, cleanupImage());
    if (backedUp && existsSync(backupSource)) await rename(backupSource, canonicalSource);
    throw error;
  }
  // Publication is committed. Residual token-private files are cleanup-only
  // and must never roll back the canonical source after its backup is gone.
  await removeWorkDir(stageDir, cleanupImage()).catch(() => undefined);
}
