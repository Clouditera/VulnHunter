import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { detectSourceArchive, stripSourceArchiveExtension } from "../../src/features/source-archives/detect.js";
import { extractSourceArchive, inspectSourceArchive } from "../../src/features/source-archives/extract.js";
import { buildSourceArchivePolicy } from "../../src/features/source-archives/policy.js";
import { SourceArchiveError } from "../../src/features/source-archives/errors.js";

const policy = buildSourceArchivePolicy({ source_archive_upload_max_mb: 500 });

describe("source archive policy", () => {
  beforeEach(() => {
    delete process.env.UPLOAD_GATEWAY_LIMIT_MB;
    delete process.env.VULNAGENT_UPLOAD_GATEWAY_LIMIT_MB;
  });

  it("derives admin/user upload ceiling from deployment env", () => {
    process.env.UPLOAD_GATEWAY_LIMIT_MB = "4096";
    expect(buildSourceArchivePolicy({ source_archive_upload_max_mb: 4096 })).toMatchObject({
      max_mb: 4096,
      gateway_max_mb: 4096,
      effective_max_mb: 4096,
      source_archive_upload_ceiling_mb: 4096,
    });
    expect(buildSourceArchivePolicy({ source_archive_upload_max_mb: 5000 })).toMatchObject({
      max_mb: 4096,
      effective_max_mb: 4096,
      source_archive_upload_ceiling_mb: 4096,
    });
    delete process.env.UPLOAD_GATEWAY_LIMIT_MB;
  });
});

describe("source archive detection", () => {
  it("accepts v1 formats and rejects unsupported formats", () => {
    expect(detectSourceArchive("demo.zip")?.format).toBe("zip");
    expect(detectSourceArchive("demo.tar")?.format).toBe("tar");
    expect(detectSourceArchive("demo.tar.gz")?.format).toBe("tar.gz");
    expect(detectSourceArchive("demo.tgz")?.format).toBe("tar.gz");
    expect(detectSourceArchive("demo.tar.bz2")).toBeNull();
    expect(detectSourceArchive("demo.rar")).toBeNull();
  });

  it("strips project names for supported archive extensions", () => {
    expect(stripSourceArchiveExtension("project.tar.gz")).toBe("project");
    expect(stripSourceArchiveExtension("project.tgz")).toBe("project");
    expect(stripSourceArchiveExtension("project.tar")).toBe("project");
    expect(stripSourceArchiveExtension("project.zip")).toBe("project");
  });
});

describe("source archive extraction", () => {
  it("extracts tar.gz regular files", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-"));
    try {
      const input = join(root, "input");
      const out = join(root, "out");
      mkdirSync(input);
      writeFileSync(join(input, "app.c"), "int main(){return 0;}\n");
      const archive = join(root, "source.tar.gz");
      execSync(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await extractSourceArchive(archive, "source.tar.gz", out, policy);
      expect(readFileSync(join(out, "app.c"), "utf-8")).toContain("int main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupt tar archives", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-"));
    try {
      const archive = join(root, "corrupt.tar");
      writeFileSync(archive, "not a tar archive");
      await expect(inspectSourceArchive(archive, "corrupt.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_CORRUPT" } satisfies Partial<SourceArchiveError>);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tar symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-"));
    try {
      const input = join(root, "input");
      mkdirSync(input);
      symlinkSync("/etc/passwd", join(input, "link"));
      const archive = join(root, "source.tar");
      execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" } satisfies Partial<SourceArchiveError>);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
