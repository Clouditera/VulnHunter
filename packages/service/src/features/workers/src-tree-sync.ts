/**
 * Source-tree first-class storage (task-c069aab9, fish 2026-08-21 "B 方案").
 *
 * The viewer's authority is the MinIO prefix `source-files/<taskId>/` — a
 * per-file tree extracted ONCE at prepare time (uploadSourceTreeToMinio) and
 * kept in sync with the agent's src/ workspace (syncSrcTreeToMinio). This
 * replaces the old viewer model of downloading the whole blob and unpacking
 * it on every tree open / file click.
 *
 * Sync design (per architecture v1.0):
 * - manifest at `<hostWorkDir>/.src-tree-manifest.json`: relPath ->
 *   {size, mtimeMs} of the LAST synced state. Diff walk: new/changed → put,
 *   vanished → delete, then write the manifest back. Corrupt/missing
 *   manifest → full re-sync (re-put everything, no deletes needed for keys
 *   that still exist; deletes still reconcile the remote key set).
 * - concurrency-capped (16) puts/deletes; failures warn and leave the entry
 *   out of the new manifest so the next pass retries it.
 * - triggers (wired in scheduler.ts): gate-passed (after disarm), every
 *   engine `stage_done` during scanning, task completion. Debounced per
 *   task: 5s trailing merge so a burst of stage_done events costs one walk.
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { getHostWorkDir } from "./scan-worker.js";
import type { ServiceConfig } from "../../infra/config.js";

const CONCURRENCY = 16;
const DEBOUNCE_MS = 5_000;

export function sourceFilesPrefix(taskId: string): string {
  return `source-files/${taskId}/`;
}

interface ManifestEntry {
  size: number;
  mtimeMs: number;
}
type Manifest = Record<string, ManifestEntry>;

function manifestPath(hostWorkDir: string): string {
  return join(hostWorkDir, ".src-tree-manifest.json");
}

function walkFiles(dir: string, base: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function readManifest(hostWorkDir: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(hostWorkDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Manifest;
  } catch {
    return null; // missing or corrupt → caller does a full re-sync
  }
}

function writeManifest(hostWorkDir: string, manifest: Manifest): void {
  try {
    writeFileSync(manifestPath(hostWorkDir), JSON.stringify(manifest));
  } catch (err) {
    logger.warn({ err, hostWorkDir }, "src-tree manifest write failed");
  }
}

/** Map with bounded concurrency over an async worker. */
async function mapLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Prepare-time one-shot upload: every extracted file under stagedSourceDir →
 * `source-files/<tid>/<rel>`. Idempotent overwrite (a --continue re-prepare
 * just re-puts). Failures only warn — the viewer falls back to the legacy
 * blob path and the task proceeds (degraded visibility, not a failed scan).
 */
export async function uploadSourceTreeToMinio(taskId: string, stagedSourceDir: string, config: ServiceConfig): Promise<number> {
  const minio = getMinio();
  const bucket = config.minio.bucket;
  const prefix = sourceFilesPrefix(taskId);
  const files = walkFiles(stagedSourceDir, stagedSourceDir);
  let ok = 0;

  await mapLimited(files, CONCURRENCY, async (filePath) => {
    const rel = relative(stagedSourceDir, filePath);
    try {
      await minio.fPutObject(bucket, prefix + rel, filePath);
      ok++;
    } catch (err) {
      logger.warn({ err, taskId, rel }, "source-files prepare upload failed (viewer falls back to blob)");
    }
  });

  logger.info({ taskId, ok, total: files.length }, "source-files prepare upload done");
  return ok;
}

interface SyncRunState {
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<number> | null;
  /** Config captured at schedule time so a bare flush can still run. */
  config: ServiceConfig;
}
const pending = new Map<string, SyncRunState>();

/** Run one incremental sync immediately (no debounce). Returns synced count. */
async function runSync(taskId: string, config: ServiceConfig): Promise<number> {
  const hostWorkDir = getHostWorkDir(config.dataDir, taskId);
  const srcDir = join(hostWorkDir, "src");
  if (!existsSync(srcDir)) return 0; // nothing to sync (workspace not materialized)

  const minio = getMinio();
  const bucket = config.minio.bucket;
  const prefix = sourceFilesPrefix(taskId);
  const prev = readManifest(hostWorkDir) ?? {};
  const next: Manifest = {};

  const files = walkFiles(srcDir, srcDir);
  const changed: string[] = [];
  for (const filePath of files) {
    const rel = relative(srcDir, filePath);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue; // vanished mid-walk; the delete pass reconciles
    }
    const entry: ManifestEntry = { size: st.size, mtimeMs: st.mtimeMs };
    const old = prev[rel];
    if (!old || old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) changed.push(filePath);
    next[rel] = entry;
  }

  // Deletes: paths in the previous manifest that no longer exist locally.
  // (When the manifest was corrupt/absent — full re-sync — prev is {} so this
  // pass is empty; remote keys that vanished before this release are left
  // alone: harmless, and the remote list reconciliation below catches them
  // only when a manifest existed. Deliberately conservative.)
  const deleted: string[] = [];
  for (const rel of Object.keys(prev)) {
    if (!(rel in next)) deleted.push(prefix + rel);
  }

  let puts = 0;
  await mapLimited(changed, CONCURRENCY, async (filePath) => {
    const rel = relative(srcDir, filePath);
    try {
      await minio.fPutObject(bucket, prefix + rel, filePath);
      puts++;
    } catch (err) {
      logger.warn({ err, taskId, rel }, "src-tree sync put failed");
      delete next[rel]; // retry on the next trigger
    }
  });

  let dels = 0;
  await mapLimited(deleted, CONCURRENCY, async (key) => {
    try {
      await minio.removeObject(bucket, key);
      dels++;
    } catch (err) {
      logger.warn({ err, taskId, key }, "src-tree sync delete failed");
    }
  });

  writeManifest(hostWorkDir, next);
  logger.info({ taskId, puts, dels, total: files.length }, "src-tree incremental sync done");
  return puts + dels;
}

/**
 * Debounced trigger (5s trailing merge per task): a burst of stage_done
 * events costs one walk. Coalesces with an in-flight run by chaining after
 * it, so no events are lost while never running two walks concurrently.
 */
export function scheduleSrcTreeSync(taskId: string, config: ServiceConfig): void {
  let state = pending.get(taskId);
  if (!state) {
    state = { timer: null, running: null, config };
    pending.set(taskId, state);
  } else {
    state.config = config;
  }
  if (state.timer) return; // already pending
  state.timer = setTimeout(() => {
    if (!state) return;
    state.timer = null;
    state.running = (state.running ?? Promise.resolve(0))
      .then(() => runSync(taskId, config))
      .catch((err) => {
        logger.warn({ err, taskId }, "src-tree sync run failed");
        return 0;
      });
  }, DEBOUNCE_MS);
}

/** Await any pending/scheduled sync for a task — running the pending walk
 * immediately instead of dropping it (cancel-only would lose the last
 * debounced trigger's changes; task completion is the final chance). */
export async function flushSrcTreeSync(taskId: string, config?: ServiceConfig): Promise<void> {
  const state = pending.get(taskId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
    const cfg = config ?? state.config;
    state.running = (state.running ?? Promise.resolve(0))
      .then(() => runSync(taskId, cfg))
      .catch((err) => {
        logger.warn({ err, taskId }, "src-tree sync flush run failed");
        return 0;
      });
  }
  await state.running;
  pending.delete(taskId);
}
