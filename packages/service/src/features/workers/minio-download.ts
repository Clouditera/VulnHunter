import { statSync, rmSync } from "node:fs";
import { logger } from "../../infra/logger.js";

/** Minimal MinIO surface used by the download helper (for testability). */
export interface MinioDownloader {
  fGetObject(bucket: string, key: string, filePath: string): Promise<unknown>;
  statObject(bucket: string, key: string): Promise<{ size: number }>;
}

export interface DownloadRetryOptions {
  retries?: number;
  delayMs?: number;
  /** Injectable for tests; defaults to fs.statSync size. */
  localSize?: (p: string) => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Download a MinIO object to a local file with retry.
 *
 * Why: `fGetObject` immediately after `putObject` can hit a transient
 * read-after-write inconsistency and throw "Size mismatch between downloaded
 * file and the object" — the object IS complete server-side (git-clone verifies
 * size on upload), but the GET stream occasionally ends short. A single
 * zero-retry call (the old behaviour) turned this recoverable blip into a
 * permanent task failure (prod task bab9d1d3 / WebGoat).
 *
 * Strategy: up to N attempts with a short delay; clear any leftover
 * `.part.minio` resume file before retrying so the client doesn't append onto a
 * half-written part; verify downloaded size == object size as a final guard.
 */
export async function downloadObjectWithRetry(
  minio: MinioDownloader,
  bucket: string,
  key: string,
  filePath: string,
  opts: DownloadRetryOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1500;
  const localSize = opts.localSize ?? ((p: string) => statSync(p).size);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await minio.fGetObject(bucket, key, filePath);
      // Final guard: verify the local file matches the object size.
      const objStat = await minio.statObject(bucket, key);
      const size = localSize(filePath);
      if (size !== objStat.size) {
        throw new Error(`Downloaded size ${size} != object ${objStat.size}`);
      }
      return; // success
    } catch (err) {
      lastErr = err;
      // Clear any half-written resume part so the next attempt starts clean.
      clearPartFiles(filePath);
      if (attempt < retries - 1) {
        logger.warn(
          { err, key, attempt: attempt + 1, retries },
          "MinIO download failed (transient?), retrying",
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

function clearPartFiles(filePath: string): void {
  // minio-js writes `${filePath}.${etag}.part.minio`; we don't know the etag,
  // so remove the base file (a short/corrupt download) defensively.
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* noop */
  }
}
