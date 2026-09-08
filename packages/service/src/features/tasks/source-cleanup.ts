import { loadConfig } from "../../infra/config.js";
import { logger } from "../../infra/logger.js";
import { getMinio } from "../../infra/minio/client.js";
import { sourceMetaObject } from "../source-archives/detect.js";
import { isSourceArchiveKeyReferenced } from "./storage.js";

const SOURCE_ARCHIVE_PREFIX = "code-packages/";

function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface SourceArchiveCleanupTask {
  id: string;
  source_meta?: unknown;
}

export interface SourceArchiveCleanupContext {
  taskId: string;
  reason: string;
}

/**
 * A deletable source archive is one exact object below code-packages/. Prefix
 * or directory deletion is intentionally impossible here. Object names from
 * chat-artifacts/ (including MCP source attachments) are outside this module.
 */
function validatedSourceArchiveKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key) return null;
  if (!key.startsWith(SOURCE_ARCHIVE_PREFIX)) return null;
  if (key === SOURCE_ARCHIVE_PREFIX || key.endsWith("/")) return null;
  if (containsControlCharacter(key)) return null;
  const segments = key.slice(SOURCE_ARCHIVE_PREFIX.length).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return key;
}

/**
 * Freeze all exact source-package keys owned by a task before its DB row is
 * deleted. The recorded keys are authoritative; the historical task-id .zip
 * key remains a conservative compatibility candidate.
 */
export function sourceArchiveCleanupKeys(task: SourceArchiveCleanupTask): string[] {
  const meta = sourceMetaObject(task.source_meta);
  const candidates: unknown[] = [
    meta.minio_key,
    meta.code_package_key,
    `code-packages/${task.id}.zip`,
  ];
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    // Empty/non-string historical fields are simply absent. A non-empty string
    // outside the exact code-packages object shape is unsafe and worth a warn.
    const original = typeof candidate === "string" ? candidate.trim() : "";
    if (!original) continue;
    const key = validatedSourceArchiveKey(candidate);
    if (!key) {
      logger.warn(
        { taskId: task.id, minioKey: original },
        "Source archive key is not eligible for task-delete cleanup; retaining object",
      );
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function isAlreadyAbsentError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; statusCode?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  return (
    e.statusCode === 404 || code === "NoSuchKey" || code === "NoSuchObject" || code === "NotFound"
  );
}

/**
 * Delete source packages only after the task's DB deletion has committed and a
 * fresh, system-wide reference query reports zero remaining users. This is
 * intentionally best-effort: DB uncertainty always retains data; MinIO errors
 * are logged per exact key and do not block task deletion or later keys.
 */
export async function cleanupUnreferencedSourceArchives(
  keys: string[],
  context: SourceArchiveCleanupContext,
): Promise<void> {
  const uniqueKeys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of keys) {
    const key = validatedSourceArchiveKey(candidate);
    if (key && !seen.has(key)) {
      seen.add(key);
      uniqueKeys.push(key);
    }
  }
  if (uniqueKeys.length === 0) return;

  let minio: ReturnType<typeof getMinio>;
  let bucket: string;
  try {
    minio = getMinio();
    bucket = loadConfig().minio.bucket;
  } catch (err) {
    for (const key of uniqueKeys) {
      logger.warn(
        { err, taskId: context.taskId, minioKey: key, reason: context.reason },
        "Source archive cleanup could not initialize MinIO (best-effort; object retained)",
      );
    }
    return;
  }

  for (const key of uniqueKeys) {
    let referenced: boolean;
    try {
      referenced = await isSourceArchiveKeyReferenced(key);
    } catch (err) {
      logger.warn(
        { err, taskId: context.taskId, minioKey: key, reason: context.reason },
        "Source archive reference check failed; object retained",
      );
      continue;
    }

    if (referenced) {
      logger.debug(
        { taskId: context.taskId, minioKey: key, reason: context.reason },
        "Source archive is still referenced; object retained",
      );
      continue;
    }

    try {
      await minio.removeObject(bucket, key);
      logger.info(
        { taskId: context.taskId, minioKey: key, reason: context.reason },
        "Unreferenced source archive deleted",
      );
    } catch (err) {
      if (isAlreadyAbsentError(err)) {
        logger.debug(
          { taskId: context.taskId, minioKey: key, reason: context.reason },
          "Source archive already absent; cleanup is idempotent",
        );
        continue;
      }
      logger.warn(
        { err, taskId: context.taskId, minioKey: key, reason: context.reason },
        "Source archive delete failed (best-effort; object may remain)",
      );
    }
  }
}
