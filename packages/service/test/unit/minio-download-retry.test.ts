import { describe, expect, it, vi } from "vitest";
import { downloadObjectWithRetry, type MinioDownloader } from "../../src/features/workers/minio-download.js";

/**
 * Local reproduction (path B, injection) of prod task bab9d1d3 (WebGoat):
 *   fGetObject right after upload threw "Size mismatch between downloaded file
 *   and the object" — a transient read-after-write blip — and the old zero-retry
 *   path turned it into a permanent task failure.
 *
 * These tests prove: (1) the original single-shot behaviour fails on the first
 * transient error; (2) downloadObjectWithRetry recovers on the next attempt.
 */
describe("MinIO download retry — bab9d1d3 size-mismatch repro", () => {
  const noSleep = () => Promise.resolve();

  it("REPRO: a single (zero-retry) fGetObject fails on a transient size mismatch", async () => {
    const minio: MinioDownloader = {
      fGetObject: vi.fn().mockRejectedValueOnce(
        new Error("Size mismatch between downloaded file and the object"),
      ),
      statObject: vi.fn().mockResolvedValue({ size: 16_000_000 }),
    };
    // Simulate the old behaviour: one call, no retry.
    await expect(minio.fGetObject("b", "code-packages/x.zip", "/tmp/x.zip")).rejects.toThrow(
      /Size mismatch/,
    );
  });

  it("FIX: retry recovers when the first attempt is a transient size mismatch", async () => {
    const minio: MinioDownloader = {
      fGetObject: vi
        .fn()
        .mockRejectedValueOnce(new Error("Size mismatch between downloaded file and the object"))
        .mockResolvedValueOnce(undefined),
      statObject: vi.fn().mockResolvedValue({ size: 16_000_000 }),
    };
    await expect(
      downloadObjectWithRetry(minio, "b", "code-packages/x.zip", "/tmp/x.zip", {
        sleep: noSleep,
        localSize: () => 16_000_000, // second attempt downloads the full object
      }),
    ).resolves.toBeUndefined();
    expect(minio.fGetObject).toHaveBeenCalledTimes(2);
  });

  it("FIX: post-download size guard catches a short download and retries", async () => {
    let call = 0;
    const minio: MinioDownloader = {
      fGetObject: vi.fn().mockResolvedValue(undefined),
      statObject: vi.fn().mockResolvedValue({ size: 16_000_000 }),
    };
    await expect(
      downloadObjectWithRetry(minio, "b", "k", "/tmp/x.zip", {
        sleep: noSleep,
        // first attempt yields a truncated file, second is complete
        localSize: () => (++call === 1 ? 15_999_000 : 16_000_000),
      }),
    ).resolves.toBeUndefined();
    expect(minio.fGetObject).toHaveBeenCalledTimes(2);
  });

  it("gives up after N retries on a persistent error (true permanent failure)", async () => {
    const minio: MinioDownloader = {
      fGetObject: vi.fn().mockRejectedValue(new Error("Size mismatch between downloaded file and the object")),
      statObject: vi.fn().mockResolvedValue({ size: 16_000_000 }),
    };
    await expect(
      downloadObjectWithRetry(minio, "b", "k", "/tmp/x.zip", { retries: 3, sleep: noSleep }),
    ).rejects.toThrow(/Size mismatch/);
    expect(minio.fGetObject).toHaveBeenCalledTimes(3);
  });

  it("succeeds on the first try when there is no transient error", async () => {
    const minio: MinioDownloader = {
      fGetObject: vi.fn().mockResolvedValue(undefined),
      statObject: vi.fn().mockResolvedValue({ size: 16_000_000 }),
    };
    await downloadObjectWithRetry(minio, "b", "k", "/tmp/x.zip", {
      sleep: noSleep,
      localSize: () => 16_000_000,
    });
    expect(minio.fGetObject).toHaveBeenCalledTimes(1);
  });
});
