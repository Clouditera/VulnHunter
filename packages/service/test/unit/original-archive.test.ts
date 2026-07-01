import { describe, expect, it } from "vitest";
import { contentTypeForArchive, originalArchiveDownloadSpec, safeDownloadFilename } from "../../src/features/tasks/original-archive.js";

describe("originalArchiveDownloadSpec", () => {
  it("returns original upload filename and MinIO key for uploaded tasks", () => {
    const spec = originalArchiveDownloadSpec({
      id: "task-1",
      project_name: "demo",
      source_type: "upload",
      source_meta: { filename: "demo.tar.gz", minio_key: "code-packages/task-1.zip" },
    } as never);

    expect(spec).toEqual({
      filename: "demo.tar.gz",
      safeFilename: "demo.tar.gz",
      minioKey: "code-packages/task-1.zip",
      contentType: "application/gzip",
    });
  });

  it("does not expose generated git source archives as original uploads", () => {
    const spec = originalArchiveDownloadSpec({
      id: "task-git",
      project_name: "repo",
      source_type: "git",
      source_meta: { git_url: "https://example.test/repo.git", minio_key: "code-packages/task-git.zip" },
    } as never);

    expect(spec).toBeNull();
  });

  it("falls back for old uploaded tasks without explicit MinIO key", () => {
    const spec = originalArchiveDownloadSpec({
      id: "task-old",
      project_name: "legacy",
      source_type: "upload",
      source_meta: { filename: "legacy.zip" },
    } as never);

    expect(spec?.minioKey).toBe("code-packages/task-old.zip");
    expect(spec?.filename).toBe("legacy.zip");
  });
});

describe("safeDownloadFilename", () => {
  it("removes path separators, control characters, quotes, and non-ascii header chars", () => {
    expect(safeDownloadFilename('../bad/"name"\r-源码.zip')).toBe(".._bad__name__-__.zip");
  });

  it("falls back for empty names", () => {
    expect(safeDownloadFilename("  ")).toBe("archive.zip");
  });
});

describe("contentTypeForArchive", () => {
  it("maps supported source archive extensions", () => {
    expect(contentTypeForArchive("a.zip")).toBe("application/zip");
    expect(contentTypeForArchive("a.tgz")).toBe("application/gzip");
    expect(contentTypeForArchive("a.tar.bz2")).toBe("application/x-bzip2");
    expect(contentTypeForArchive("a.bin")).toBe("application/octet-stream");
  });
});
