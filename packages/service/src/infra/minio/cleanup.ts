/**
 * MinIO artifact cleanup helpers (design: minio-artifact-cleanup-v1.0).
 *
 * Shape everywhere: DB commit first, object deletion after, best-effort with
 * warn logging — orphans left behind are the sweeper's job, never a blocker.
 */
import { getMinio } from "./client.js";
import { logger } from "../logger.js";

export interface BucketObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

const REMOVE_BATCH = 500;

/** List all objects under a prefix (recursive). */
export async function listBucketObjects(bucket: string, prefix: string): Promise<BucketObject[]> {
  const minio = getMinio();
  return new Promise<BucketObject[]>((resolve, reject) => {
    const out: BucketObject[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => {
      if (obj.name) {
        out.push({
          key: obj.name,
          size: obj.size ?? 0,
          lastModified: obj.lastModified ? new Date(obj.lastModified) : null,
        });
      }
    });
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });
}

/** Remove keys in batches; never throws — returns how many were deleted. */
export async function removeKeysBestEffort(
  bucket: string,
  keys: string[],
  label: string,
): Promise<number> {
  if (keys.length === 0) return 0;
  const minio = getMinio();
  let deleted = 0;
  for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
    const batch = keys.slice(i, i + REMOVE_BATCH);
    try {
      await minio.removeObjects(bucket, batch);
      deleted += batch.length;
    } catch (err) {
      logger.warn({ err, label, batchSize: batch.length }, "MinIO cleanup batch failed (best-effort; sweeper will retry)");
    }
  }
  return deleted;
}

/** Remove every object under a prefix; never throws — returns count deleted. */
export async function removePrefixBestEffort(
  bucket: string,
  prefix: string,
  label: string,
): Promise<number> {
  try {
    const objects = await listBucketObjects(bucket, prefix);
    return await removeKeysBestEffort(bucket, objects.map((o) => o.key), label);
  } catch (err) {
    logger.warn({ err, label, prefix }, "MinIO prefix cleanup failed (best-effort; sweeper will retry)");
    return 0;
  }
}
