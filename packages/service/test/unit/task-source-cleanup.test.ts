import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  referenced: new Map<string, boolean>(),
  queryFailures: new Set<string>(),
  deleteFailures: new Map<string, unknown>(),
  minioUnavailable: false,
  removed: [] as Array<{ bucket: string; key: string }>,
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../src/features/tasks/storage.js", () => ({
  isSourceArchiveKeyReferenced: vi.fn(async (key: string) => {
    if (m.queryFailures.has(key)) throw new Error(`db down for ${key}`);
    return m.referenced.get(key) ?? false;
  }),
}));

vi.mock("../../src/infra/config.js", () => ({
  loadConfig: () => ({ minio: { bucket: "artifact-store" } }),
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => {
    if (m.minioUnavailable) throw new Error("MinIO client unavailable");
    return {
      removeObject: vi.fn(async (bucket: string, key: string) => {
        const failure = m.deleteFailures.get(key);
        if (failure) throw failure;
        m.removed.push({ bucket, key });
      }),
    };
  },
}));

vi.mock("../../src/infra/logger.js", () => ({
  logger: { warn: m.warn, debug: m.debug, info: m.info, error: vi.fn() },
}));

const { cleanupUnreferencedSourceArchives, sourceArchiveCleanupKeys } = await import(
  "../../src/features/tasks/source-cleanup.js"
);

const TASK_ID = "11111111-2222-4333-8444-555566667777";
const DEFAULT_KEY = `code-packages/${TASK_ID}.zip`;

beforeEach(() => {
  m.referenced.clear();
  m.queryFailures.clear();
  m.deleteFailures.clear();
  m.minioUnavailable = false;
  m.removed.length = 0;
  m.warn.mockClear();
  m.debug.mockClear();
  m.info.mockClear();
});

describe("sourceArchiveCleanupKeys", () => {
  it("freezes trimmed real meta keys plus the legacy default, de-duplicated", () => {
    expect(
      sourceArchiveCleanupKeys({
        id: TASK_ID,
        source_meta: {
          minio_key: "  code-packages/upload-uuid.tar.gz  ",
          code_package_key: "code-packages/copied.zip",
        },
      }),
    ).toEqual(["code-packages/upload-uuid.tar.gz", "code-packages/copied.zip", DEFAULT_KEY]);

    expect(
      sourceArchiveCleanupKeys({
        id: TASK_ID,
        source_meta: { minio_key: DEFAULT_KEY, code_package_key: ` ${DEFAULT_KEY} ` },
      }),
    ).toEqual([DEFAULT_KEY]);
  });

  it.each(["zip", "jar", "war", "tar", "tar.gz", "tgz"])(
    "accepts the exact recorded code-packages key regardless of .%s format",
    (ext) => {
      const key = `code-packages/upload-id.${ext}`;
      expect(
        sourceArchiveCleanupKeys({
          id: TASK_ID,
          source_meta: { minio_key: key },
        }),
      ).toContain(key);
    },
  );

  it("handles JSON-string/unknown/legacy source_meta without crashing", () => {
    expect(
      sourceArchiveCleanupKeys({
        id: TASK_ID,
        source_meta: JSON.stringify({ minio_key: "code-packages/string-meta.zip" }),
      }),
    ).toEqual(["code-packages/string-meta.zip", DEFAULT_KEY]);
    expect(sourceArchiveCleanupKeys({ id: TASK_ID, source_meta: "not-json" })).toEqual([
      DEFAULT_KEY,
    ]);
    expect(sourceArchiveCleanupKeys({ id: TASK_ID, source_meta: null })).toEqual([DEFAULT_KEY]);
  });

  it.each([
    ["other prefix", "chat-artifacts/source.zip"],
    ["prefix root", "code-packages/"],
    ["directory", "code-packages/a/"],
    ["dot segment", "code-packages/./a.zip"],
    ["dot-dot segment", "code-packages/a/../b.zip"],
    ["control character", "code-packages/a\u0000.zip"],
    ["newline", "code-packages/a\nb.zip"],
  ])("warns and rejects %s", (_name, key) => {
    const got = sourceArchiveCleanupKeys({
      id: TASK_ID,
      source_meta: { minio_key: key },
    });
    expect(got).toEqual([DEFAULT_KEY]);
    expect(m.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK_ID }),
      expect.stringContaining("not eligible"),
    );
  });

  it("ignores non-string meta values and never treats them as object keys", () => {
    expect(
      sourceArchiveCleanupKeys({
        id: TASK_ID,
        source_meta: { minio_key: 123, code_package_key: true },
      }),
    ).toEqual([DEFAULT_KEY]);
  });
});

describe("cleanupUnreferencedSourceArchives", () => {
  it("deletes only exact unreferenced keys and preserves referenced keys", async () => {
    m.referenced.set("code-packages/shared.zip", true);
    await cleanupUnreferencedSourceArchives(
      ["code-packages/unique.zip", "code-packages/shared.zip"],
      { taskId: TASK_ID, reason: "task-delete" },
    );
    expect(m.removed).toEqual([{ bucket: "artifact-store", key: "code-packages/unique.zip" }]);
    expect(m.debug).toHaveBeenCalledWith(
      expect.objectContaining({ minioKey: "code-packages/shared.zip", taskId: TASK_ID }),
      expect.stringContaining("still referenced"),
    );
  });

  it("an unavailable MinIO client logs every exact key and leaves all objects retained", async () => {
    m.minioUnavailable = true;
    await cleanupUnreferencedSourceArchives(["code-packages/one.zip", "code-packages/two.zip"], {
      taskId: TASK_ID,
      reason: "task-delete",
    });
    expect(m.removed).toEqual([]);
    expect(m.warn).toHaveBeenCalledTimes(2);
    expect(m.warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ minioKey: "code-packages/one.zip", taskId: TASK_ID }),
      expect.stringContaining("initialize MinIO"),
    );
    expect(m.warn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ minioKey: "code-packages/two.zip", taskId: TASK_ID }),
      expect.stringContaining("initialize MinIO"),
    );
  });

  it("a DB reference-query failure forbids that deletion but continues other keys", async () => {
    m.queryFailures.add("code-packages/db-failed.zip");
    await cleanupUnreferencedSourceArchives(
      ["code-packages/db-failed.zip", "code-packages/next.zip"],
      { taskId: TASK_ID, reason: "task-delete" },
    );
    expect(m.removed).toEqual([{ bucket: "artifact-store", key: "code-packages/next.zip" }]);
    expect(m.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minioKey: "code-packages/db-failed.zip", taskId: TASK_ID }),
      expect.stringContaining("reference check failed"),
    );
  });

  it("a MinIO deletion failure is explicit and does not skip the next object", async () => {
    m.deleteFailures.set("code-packages/delete-failed.zip", new Error("minio unavailable"));
    await cleanupUnreferencedSourceArchives(
      ["code-packages/delete-failed.zip", "code-packages/next.zip"],
      { taskId: TASK_ID, reason: "task-delete" },
    );
    expect(m.removed).toEqual([{ bucket: "artifact-store", key: "code-packages/next.zip" }]);
    expect(m.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minioKey: "code-packages/delete-failed.zip", taskId: TASK_ID }),
      expect.stringContaining("delete failed"),
    );
  });

  it("an already-missing object is an idempotent success, not a false failure", async () => {
    m.deleteFailures.set("code-packages/gone.zip", { code: "NoSuchKey", statusCode: 404 });
    await cleanupUnreferencedSourceArchives(["code-packages/gone.zip"], {
      taskId: TASK_ID,
      reason: "task-delete",
    });
    expect(m.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ minioKey: "code-packages/gone.zip" }),
      expect.stringContaining("delete failed"),
    );
    expect(m.debug).toHaveBeenCalledWith(
      expect.objectContaining({ minioKey: "code-packages/gone.zip" }),
      expect.stringContaining("already absent"),
    );
  });
});
