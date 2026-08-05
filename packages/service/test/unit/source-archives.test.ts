import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { detectSourceArchive, stripSourceArchiveExtension } from "../../src/features/source-archives/detect.js";
import { assertSourceArchiveEntryCount, extractSourceArchive, inspectSourceArchive, prepareSourceArchiveDestination } from "../../src/features/source-archives/extract.js";
import { buildSourceArchivePolicy, SOURCE_ARCHIVE_MAX_FILES } from "../../src/features/source-archives/policy.js";
import { SourceArchiveError } from "../../src/features/source-archives/errors.js";

const policy = buildSourceArchivePolicy({ source_archive_upload_max_mb: 500 });

describe("source archive policy", () => {
  beforeEach(() => {
    delete process.env.UPLOAD_GATEWAY_LIMIT_MB;
    delete process.env.VULNHUNTER_UPLOAD_GATEWAY_LIMIT_MB;
  });

  it("derives admin/user upload ceiling from deployment env", () => {
    process.env.UPLOAD_GATEWAY_LIMIT_MB = "4096";
    expect(buildSourceArchivePolicy({ source_archive_upload_max_mb: 4096 })).toMatchObject({
      max_mb: 4096,
      gateway_max_mb: 4096,
      effective_max_mb: 4096,
      source_archive_upload_ceiling_mb: 4096,
      accept: ".zip,.tar,.gz,.tgz,application/zip,application/x-tar,application/gzip,application/x-gzip",
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
  it("enforces the entry ceiling for directories as well as files", () => {
    expect(() => assertSourceArchiveEntryCount(SOURCE_ARCHIVE_MAX_FILES)).not.toThrow();
    expect(() => assertSourceArchiveEntryCount(SOURCE_ARCHIVE_MAX_FILES + 1)).toThrow(expect.objectContaining({ code: "ERR_SOURCE_ARCHIVE_TOO_MANY_FILES" }));
  });

  it("prepares an absent atomic-publish destination", () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-destination-"));
    try {
      const destination = join(root, "workspace", "src"); mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, "stale"), "old");
      prepareSourceArchiveDestination(destination);
      expect(existsSync(join(root, "workspace"))).toBe(true); expect(existsSync(destination)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps scan and report callers on the absent-destination contract", () => {
    const callers = [
      // The scheduler extracts into a fresh token-private staging dir
      // (.scheduler-prepare-<token>/src) that never pre-exists, then publishes
      // atomically by rename — the absent-destination contract is structural.
      ["src/features/workers/scheduler.ts", "extractSourceArchive(archivePath, archive.filename, stagedSourceDir"],
      ["src/features/reports/report-worker.ts", "prepareSourceArchiveDestination(sourceDir);"],
    ];
    for (const [file, call] of callers) expect(readFileSync(join(process.cwd(), file), "utf8")).toContain(call);
  });

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

  it.each([
    ["source.zip", "zip -qry -y"],
    ["source.tar", "tar -cf"],
    ["source.tar.gz", "tar -czf"],
    ["source.tgz", "tar -czf"],
  ])("extracts safe relative symlinks from %s", async (filename, command) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-link-"));
    try {
      const input = join(root, "input"); const out = join(root, "out"); mkdirSync(join(input, "server"), { recursive: true });
      writeFileSync(join(input, "server", "LICENSE"), "license\n"); symlinkSync("server/LICENSE", join(input, "LICENSE.enterprise"));
      const archive = join(root, filename);
      if (filename.endsWith(".zip")) execSync(`${command} ${JSON.stringify(archive)} .`, { cwd: input });
      else execSync(`${command} ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await inspectSourceArchive(archive, filename, policy); await extractSourceArchive(archive, filename, out, policy);
      expect(lstatSync(join(out, "LICENSE.enterprise")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(out, "LICENSE.enterprise"))).toBe("server/LICENSE");
      expect(readFileSync(join(out, "LICENSE.enterprise"), "utf8")).toBe("license\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["escape", "../../outside"],
    ["dangling", "missing"],
  ])("rejects %s symlink targets atomically", async (_kind, target) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-bad-link-"));
    try {
      const input = join(root, "input"); const out = join(root, "out"); mkdirSync(input); writeFileSync(join(input, "file"), "ok"); symlinkSync(target, join(input, "link"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(extractSourceArchive(archive, "source.tar", out, policy)).rejects.toBeInstanceOf(SourceArchiveError);
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(".source-extract-"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["escape", "../../outside"],
    ["dangling", "missing"],
  ])("rejects %s ZIP symlink targets", async (_kind, target) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-bad-zip-link-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "file"), "ok"); symlinkSync(target, join(input, "link"));
      const archive = join(root, "source.zip"); execSync(`zip -qry -y ${JSON.stringify(archive)} .`, { cwd: input });
      await expect(inspectSourceArchive(archive, "source.zip", policy)).rejects.toBeInstanceOf(SourceArchiveError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects symlink cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-cycle-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "regular"), "ok"); symlinkSync("b", join(input, "a")); symlinkSync("a", join(input, "b"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects over-deep symlink chains", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-deep-links-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "target"), "ok");
      for (let index = 0; index < 42; index += 1) symlinkSync(index === 41 ? "target" : `link-${index + 1}`, join(input, `link-${index}`));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an entry below a symlink parent without touching outside", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-parent-link-"));
    try {
      const input = join(root, "input"); const outside = join(root, "outside"); const out = join(root, "out"); mkdirSync(input); mkdirSync(outside);
      mkdirSync(join(input, "target")); writeFileSync(join(input, "target", "base"), "ok"); writeFileSync(join(input, "payload"), "attack"); writeFileSync(join(outside, "sentinel"), "keep"); symlinkSync("target", join(input, "dir"));
      const archive = join(root, "source.tar");
      execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} dir target && tar -rf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} --transform='s#^payload$#dir/pwn#' payload`);
      await expect(extractSourceArchive(archive, "source.tar", out, policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep"); expect(existsSync(join(outside, "pwn"))).toBe(false); expect(existsSync(out)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects duplicate canonical paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-duplicate-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "file"), "ok");
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} file && tar -rf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} file`);
      await expect(inspectSourceArchive(archive, "source.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects backslashes in entry paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-backslash-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "bad\\name"), "ok");
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSAFE_PATH" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("continues to reject tar hardlinks and FIFOs", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-special-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "file"), "ok"); execSync(`ln ${JSON.stringify(join(input, "file"))} ${JSON.stringify(join(input, "hard"))}`); execSync(`mkfifo ${JSON.stringify(join(input, "pipe"))}`);
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
