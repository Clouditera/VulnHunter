/**
 * Sync worker outputs from bind-mount workDir to MinIO.
 * Called by scheduler after worker completes (before indexing).
 *
 * HALL-18 (fd 泄漏根治 2026-08-26):
 *  - 增量同步（includeDirs）走变更检测：服务工作区侧维护 manifest
 *    (`<hostWorkDir>/.out-sync-manifest.json`, relPath → {size, mtimeMs})，
 *    每轮只上传新增/变更文件；首轮或 manifest 损坏 → 全量。
 *    修复：此前每 90s 对全部文件重传（eeric 6632 个/轮），是 EMFILE 的
 *    fd 吞吐主因。
 *  - 上传流生命周期受控：改用自管理 `createReadStream` + `putObject`，
 *    `finally` 中显式 `destroy()`（minio fPutObject 的 fs 流依赖 GC
 *    finalizer 关闭，fd 压力下不可靠 → 泄漏 pos=0 的 O_RDONLY fd）。
 *    put 并发上限 CONCURRENCY（参照 src-tree-sync 模式），避免 fd 峰值。
 *  - 终端全量同步（无 includeDirs）始终全树重传，且重写 manifest ——
 *    worker 完成后 out/ 即最终态，manifest 记录该终态供 continue 任务
 *    的后续增量轮正确判变。
 */

import { join, relative, dirname } from "node:path";
import { readdirSync, existsSync, readFileSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { lookup as mimeLookup } from "mime-types";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { getHostWorkDir } from "./scan-worker.js";
import { ensureWorkDir } from "./docker-client.js";
import type { ServiceConfig } from "../../infra/config.js";

/** HALL-18 A2: put 并发上限 — fd 峰值受控（8–16 区间取 8，见 issue 方案）。 */
const CONCURRENCY = 8;

/** 同步清单文件名（位于 hostWorkDir，服务自有路径，worker 不写这里）。 */
const MANIFEST_NAME = ".out-sync-manifest.json";

interface ManifestEntry {
  size: number;
  mtimeMs: number;
}
type Manifest = Record<string, ManifestEntry>;

function manifestPath(hostWorkDir: string): string {
  return join(hostWorkDir, MANIFEST_NAME);
}

function readManifest(hostWorkDir: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(hostWorkDir), "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as Manifest;
  } catch {
    return null; // missing or corrupt → caller does a full sync
  }
}

function writeManifest(hostWorkDir: string, manifest: Manifest): void {
  try {
    writeFileSync(manifestPath(hostWorkDir), JSON.stringify(manifest));
  } catch (err) {
    logger.warn({ err, hostWorkDir }, "out-sync manifest write failed");
  }
}

/**
 * Walk worker outputs. Dirent types are lstat-based (HALL-20 security):
 * a symlink is seen as itself, never followed — the worker runs as root and
 * the service as a lower-privileged uid, so following a link in out/ would
 * make the service read (with its own identity) and upload a file outside
 * the workspace (e.g. .secrets/, other tasks' workspaces). Other non-regular
 * entries (FIFO/socket/device) are also skipped: reading a FIFO would hang
 * the sync, and none are legal artifact forms.
 *
 * ctx carries taskId/baseDir so skip warns keep their semantics now that the
 * walker is a module-level function (HALL-18 A1 refactor folded HALL-20's
 * closure-based skipping into it during the rebase onto #49).
 */
interface WalkCtx {
  taskId: string;
  baseDir: string;
}

function walkDir(dir: string, ctx: WalkCtx): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, ctx));
      continue;
    }
    if (entry.isSymbolicLink()) {
      logger.warn(
        { taskId: ctx.taskId, path: relative(ctx.baseDir, full) },
        "skipping symlink in scan outputs (not a legal artifact form)",
      );
      continue;
    }
    if (!entry.isFile()) {
      logger.warn(
        { taskId: ctx.taskId, path: relative(ctx.baseDir, full) },
        "skipping non-regular file in scan outputs",
      );
      continue;
    }
    results.push(full);
  }
  return results;
}

/** Map with bounded concurrency over an async worker (fd 峰值受控). */
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
 * HALL-18 A2: 生命周期受控的单文件上传。
 * 自管理 createReadStream → putObject，finally 中显式 destroy —— 成功与
 * 失败路径都保证 fd 关闭（对齐 fPutObject 的 content-type 推断行为：
 * mime-types lookup，未知扩展 → application/octet-stream）。
 */
async function putFileControlled(
  bucket: string,
  objectName: string,
  filePath: string,
): Promise<void> {
  const size = statSync(filePath).size;
  const contentType = mimeLookup(filePath) || "application/octet-stream";
  const stream = createReadStream(filePath, { autoClose: false });
  try {
    // autoClose:false + finally destroy：销毁动作由我们唯一持有，避免依赖
    // minio 内部错误路径是否消费/关闭流（取证中的泄漏形态）。
    await getMinio().putObject(bucket, objectName, stream, size, { "Content-Type": contentType });
  } finally {
    stream.destroy();
  }
}

export async function syncOutputsToMinio(
  taskId: string,
  config: ServiceConfig,
  opts?: { includeDirs?: string[] },
): Promise<number> {
  const hostWorkDir = getHostWorkDir(config.dataDir, taskId);
  const outDir = join(hostWorkDir, "out");

  if (!existsSync(outDir)) {
    logger.debug({ taskId }, "No output directory to sync");
    return 0;
  }

  const bucket = config.minio.bucket;
  const prefix = `scan-outputs/${taskId}/`;
  const incremental = Boolean(opts?.includeDirs);

  // Incremental syncs (running tasks) pass includeDirs to sync only the
  // lightweight business artifacts (findings/risks/knowledge), skipping the
  // potentially GB-scale `.youngflow/sessions/` logs. The terminal sync passes
  // nothing → full tree.
  const roots = (opts?.includeDirs && opts.includeDirs.length > 0)
    ? opts.includeDirs.map((d) => join(outDir, d)).filter((d) => existsSync(d))
    : [outDir];

  const files = roots.flatMap((root) => walkDir(root, { taskId, baseDir: outDir }));

  // HALL-18 A1: 增量轮做变更检测 —— 只上传 manifest 中新增/变更的文件。
  // 终端全量轮不做跳过（out/ 终态重传），但重写 manifest 为终态。
  const prev: Manifest | null = incremental ? (readManifest(hostWorkDir) ?? {}) : {};
  const next: Manifest = {};

  const pending: string[] = [];
  for (const filePath of files) {
    const relPath = relative(outDir, filePath);
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue; // vanished mid-walk
    }
    const entry: ManifestEntry = { size: st.size, mtimeMs: st.mtimeMs };
    const old = prev[relPath];
    if (!old || old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) {
      pending.push(filePath);
    }
    next[relPath] = entry;
  }

  let synced = 0;
  await mapLimited(pending, CONCURRENCY, async (filePath) => {
    const relPath = relative(outDir, filePath);
    const objectName = prefix + relPath;
    try {
      await putFileControlled(bucket, objectName, filePath);
      synced++;
    } catch (err) {
      // 上传失败 → 从 next 移除，manifest 不记录，下一轮重试。
      delete next[relPath];
      logger.warn({ err, filePath, objectName }, "Failed to sync file to MinIO");
    }
  });

  // 全量轮也落 manifest：记录终态基线 — continue 任务的后续增量轮判变
  // 需要（增量轮只覆盖 includeDirs 子集，其余键沿用本基线）。上传失败的
  // 键已从 next 移除，下轮会重试。
  writeManifest(hostWorkDir, next);

  logger.info(
    { taskId, synced, total: files.length, pending: pending.length, incremental },
    "Outputs synced to MinIO",
  );
  return synced;
}

/**
 * Download historical scan outputs from MinIO back into the worker workspace.
 * Used by CONTINUE mode (the reverse of syncOutputsToMinio): VulnForge's
 * `--continue` needs the prior business artifacts (findings/risks/knowledge/
 * hypotheses/...) present in /workspace/out.
 *
 * IMPORTANT permission model: the worker runs as root and writes out/ as uid 0,
 * while the service runs as uid 1000. The service therefore CANNOT write into an
 * existing root-owned out/ tree. For a completed→continue on the same host the
 * workspace out/ already persists on disk, so we skip the download entirely and
 * let the worker --continue build on the on-disk artifacts. We only download
 * (into a freshly-created, service-owned out/) when the workspace was wiped
 * (e.g. service moved hosts / disk cleaned), where no permission conflict arises.
 *
 * Skips `.youngflow/sessions/` (LLM conversation logs, often GB-scale) — these
 * are not needed for --continue, which archives the old engine state and starts
 * a fresh run.
 *
 * Returns the number of objects downloaded (0 when skipped because outputs are
 * already present on disk).
 */
export async function downloadOutputsFromMinio(
  taskId: string,
  config: ServiceConfig,
): Promise<number> {
  const hostWorkDir = getHostWorkDir(config.dataDir, taskId);
  const outDir = join(hostWorkDir, "out");

  // If outputs already exist on disk (persisted workspace), do NOT touch them.
  // The worker (root) owns these files; the service (uid 1000) cannot overwrite
  // them, and the worker --continue can use them directly.
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    logger.info({ taskId }, "Historical outputs already present on disk; skipping MinIO download for continue");
    return 0;
  }

  ensureWorkDir(outDir);

  const minio = getMinio();
  const bucket = config.minio.bucket;
  const prefix = `scan-outputs/${taskId}/`;

  const keys = await new Promise<string[]>((resolve, reject) => {
    const acc: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) acc.push(obj.name); });
    stream.on("end", () => resolve(acc));
    stream.on("error", reject);
  });

  let downloaded = 0;
  for (const key of keys) {
    // Skip LLM conversation logs — not needed for --continue.
    if (key.includes(".youngflow/sessions/")) continue;
    const relPath = key.slice(prefix.length);
    if (!relPath) continue;
    const localPath = join(outDir, relPath);
    try {
      ensureWorkDir(dirname(localPath));
      await minio.fGetObject(bucket, key, localPath);
      downloaded++;
    } catch (err) {
      logger.warn({ err, key, localPath }, "Failed to download output for continue");
    }
  }

  logger.info({ taskId, downloaded, total: keys.length }, "Historical outputs downloaded for continue");
  return downloaded;
}
