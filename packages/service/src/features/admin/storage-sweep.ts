/**
 * Orphan storage sweeper (design: minio-artifact-cleanup-v1.0 §B).
 *
 * POST /api/admin/system/storage-sweep?dry=1 (default: report only)
 * POST /api/admin/system/storage-sweep?dry=0 (execute deletions)
 *
 * Safety: only the five platform prefixes are ever scanned (sandbox-plane
 * prefixes are untouched by construction); objects younger than 24h are
 * exempt (in-flight tasks/uploads); deletions are batched and audit-logged.
 */
import { Hono } from "hono";
import { getDb } from "../../infra/db/client.js";
import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { listBucketObjects, removeKeysBestEffort, type BucketObject } from "../../infra/minio/cleanup.js";

const YOUNG_EXEMPTION_MS = 24 * 60 * 60 * 1000;

interface IdSets {
  tasks: Set<string>;
  sessions: Set<string>;
  reports: Set<string>;
}

export interface PrefixReport {
  prefix: string;
  objects: number;
  bytes: number;
  young: number;
  orphans: number;
  orphanBytes: number;
  samples: string[];
  deleted?: number;
  /** Set when the prefix could not be listed — never report zero on failure. */
  error?: string;
}

/** Pure: is this key an orphan under its prefix? (null = not an orphan) */
export function classifyOrphan(prefix: string, key: string, ids: IdSets): "orphan" | null {
  const rel = key.slice(prefix.length);
  const owner = rel.split("/")[0];
  if (!owner) return null;
  switch (prefix) {
    case "code-packages/":
    case "scan-outputs/":
      return ids.tasks.has(owner) ? null : "orphan";
    case "chat-artifacts/":
    case "chat-sessions/":
      return ids.sessions.has(owner) ? null : "orphan";
    case "user-reports/": {
      // user-reports/<taskId>/<reportId>/<file> — orphan if task OR report is gone
      const reportId = rel.split("/")[1] ?? "";
      if (!ids.tasks.has(owner)) return "orphan";
      if (reportId && !ids.reports.has(reportId)) return "orphan";
      return null;
    }
    default:
      return null;
  }
}

export const SWEEP_PREFIXES = [
  "code-packages/",
  "scan-outputs/",
  "user-reports/",
  "chat-artifacts/",
  "chat-sessions/",
] as const;

async function loadIdSets(): Promise<IdSets> {
  const db = getDb();
  const [tasks, sessions, reports] = await Promise.all([
    db<{ id: string }[]>`SELECT id FROM tasks`,
    db<{ id: string }[]>`SELECT id FROM chat_sessions`,
    db<{ id: string }[]>`SELECT id FROM user_reports`,
  ]);
  return {
    tasks: new Set(tasks.map((r) => r.id)),
    sessions: new Set(sessions.map((r) => r.id)),
    reports: new Set(reports.map((r) => r.id)),
  };
}

function isYoung(obj: BucketObject, now: number): boolean {
  if (!obj.lastModified) return false;
  return now - obj.lastModified.getTime() < YOUNG_EXEMPTION_MS;
}

export async function sweepStorage(dry: boolean): Promise<{ dry: boolean; partial: boolean; prefixes: PrefixReport[] }> {
  const config = loadConfig();
  const bucket = config.minio.bucket;
  const ids = await loadIdSets();
  const now = Date.now();
  const reports: PrefixReport[] = [];
  let partial = false;

  for (const prefix of SWEEP_PREFIXES) {
    let objects: BucketObject[] = [];
    try {
      objects = await listBucketObjects(bucket, prefix);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, prefix }, "sweep: list failed; prefix reported as error, not zero");
      reports.push({ prefix, objects: 0, bytes: 0, young: 0, orphans: 0, orphanBytes: 0, samples: [], error: message.slice(0, 200) });
      partial = true;
      continue;
    }
    const orphanKeys: string[] = [];
    let bytes = 0;
    let orphanBytes = 0;
    let young = 0;
    for (const obj of objects) {
      bytes += obj.size;
      if (isYoung(obj, now)) {
        young += 1;
        continue;
      }
      if (classifyOrphan(prefix, obj.key, ids) === "orphan") {
        orphanKeys.push(obj.key);
        orphanBytes += obj.size;
      }
    }
    const report: PrefixReport = {
      prefix,
      objects: objects.length,
      bytes,
      young,
      orphans: orphanKeys.length,
      orphanBytes,
      samples: orphanKeys.slice(0, 5),
    };
    if (!dry && orphanKeys.length > 0) {
      report.deleted = await removeKeysBestEffort(bucket, orphanKeys, `storage-sweep:${prefix}`);
      logger.warn(
        { prefix, orphans: orphanKeys.length, orphanBytes, deleted: report.deleted },
        "storage-sweep: orphans deleted",
      );
    }
    reports.push(report);
  }
  return { dry, partial, prefixes: reports };
}

export const storageSweepRouter = new Hono();

storageSweepRouter.post("/", async (c) => {
  const dry = c.req.query("dry") !== "0";
  const result = await sweepStorage(dry);
  logger.warn({ dry, summary: result.prefixes.map((p) => ({ prefix: p.prefix, orphans: p.orphans, deleted: p.deleted })) },
    "storage-sweep executed");
  return c.json(result);
});
