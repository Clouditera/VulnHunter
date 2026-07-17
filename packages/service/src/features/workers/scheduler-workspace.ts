import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

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
    else await rm(backupSource, { recursive: true, force: true });
  }
  await rm(getSchedulerPrepareDir(hostWorkDir, token), { recursive: true, force: true });
}

export async function publishSchedulerWorkspace(hostWorkDir: string, token: string): Promise<void> {
  const stageDir = getSchedulerPrepareDir(hostWorkDir, token);
  const stagedSource = join(stageDir, "src");
  const canonicalSource = join(hostWorkDir, "src");
  const backupSource = getSchedulerBackupDir(hostWorkDir, token);
  if (!existsSync(stagedSource)) throw new Error("Claim staging source is missing");
  await mkdir(hostWorkDir, { recursive: true });
  await rm(backupSource, { recursive: true, force: true });
  let backedUp = false;
  if (existsSync(canonicalSource)) {
    await rename(canonicalSource, backupSource);
    backedUp = true;
  }
  try {
    await rename(stagedSource, canonicalSource);
    if (backedUp) await rm(backupSource, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(canonicalSource)) await rm(canonicalSource, { recursive: true, force: true });
    if (backedUp && existsSync(backupSource)) await rename(backupSource, canonicalSource);
    throw error;
  }
  // Publication is committed. Residual token-private files are cleanup-only
  // and must never roll back the canonical source after its backup is gone.
  await rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
}
