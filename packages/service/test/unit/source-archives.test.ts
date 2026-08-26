import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { detectSourceArchive, stripSourceArchiveExtension, SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS } from "../../src/features/source-archives/detect.js";
import { assertSourceArchiveEntryCount, extractSourceArchive, inspectSourceArchive, prepareSourceArchiveDestination } from "../../src/features/source-archives/extract.js";
import { buildSourceArchivePolicy, SOURCE_ARCHIVE_MAX_FILES } from "../../src/features/source-archives/policy.js";
import { SourceArchiveError } from "../../src/features/source-archives/errors.js";
import type { SourceArchiveWarning } from "../../src/features/source-archives/errors.js";

const policy = buildSourceArchivePolicy({ source_archive_upload_max_mb: 500 });
const rejectPolicy = buildSourceArchivePolicy({ source_archive_upload_max_mb: 500, source_archive_symlink_policy: "reject" });

function makeArchiveWithLink(root: string, target: string, linkName = "link"): { archive: string; input: string } {
  const input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "file"), "ok");
  symlinkSync(target, join(input, linkName));
  const archive = join(root, "source.tar");
  execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
  return { archive, input };
}

function makeZipArchiveWithLink(root: string, target: string, linkName = "link"): string {
  const input = join(root, "input");
  mkdirSync(input);
  writeFileSync(join(input, "file"), "ok");
  symlinkSync(target, join(input, linkName));
  const archive = join(root, "source.zip");
  execSync(`zip -qry -y ${JSON.stringify(archive)} .`, { cwd: input });
  return archive;
}

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
      accept: ".zip,.jar,.war,.tar,.gz,.tgz,application/zip,application/x-tar,application/gzip,application/x-gzip,application/java-archive",
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

  it("detects .jar/.war as zip containers (batch 3 java upload path)", () => {
    // format=zip drives extraction + listing through the zip reader; the
    // original extension is preserved for provenance; storage stays .zip.
    expect(detectSourceArchive("app.jar")).toEqual({ format: "zip", extension: ".jar", storageExtension: ".zip" });
    expect(detectSourceArchive("target.WAR")).toEqual({ format: "zip", extension: ".war", storageExtension: ".zip" });
    expect(SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS).toContain(".jar");
    expect(SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS).toContain(".war");
  });

  it("strips project names for supported archive extensions", () => {
    expect(stripSourceArchiveExtension("project.tar.gz")).toBe("project");
    expect(stripSourceArchiveExtension("project.tgz")).toBe("project");
    expect(stripSourceArchiveExtension("project.tar")).toBe("project");
    expect(stripSourceArchiveExtension("project.zip")).toBe("project");
    expect(stripSourceArchiveExtension("project.jar")).toBe("project");
    expect(stripSourceArchiveExtension("project.war")).toBe("project");
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

  it("extracts .jar uploads through the zip path (batch 3)", async () => {
    // A real jar IS a zip; build one with the zip CLI so the extraction path
    // is the exact production route (detect → zip reader → src/).
    const root = mkdtempSync(join(tmpdir(), "source-archive-jar-"));
    try {
      const input = join(root, "input");
      const out = join(root, "out");
      mkdirSync(input, { recursive: true });
      writeFileSync(join(input, "Main.class"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 1, 2, 3, 4]));
      const archive = join(root, "app.jar");
      execSync(`zip -qry ${JSON.stringify(archive)} .`, { cwd: input });
      await inspectSourceArchive(archive, "app.jar", policy);
      await extractSourceArchive(archive, "app.jar", out, policy);
      expect(readFileSync(join(out, "Main.class")).subarray(0, 4)).toEqual(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts .war uploads through the zip path (batch 3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-war-"));
    try {
      const input = join(root, "input");
      const out = join(root, "out");
      mkdirSync(join(input, "WEB-INF", "classes"), { recursive: true });
      writeFileSync(join(input, "WEB-INF", "classes", "App.class"), Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
      const archive = join(root, "target.war");
      execSync(`zip -qry ${JSON.stringify(archive)} .`, { cwd: input });
      await inspectSourceArchive(archive, "target.war", policy);
      await extractSourceArchive(archive, "target.war", out, policy);
      expect(existsSync(join(out, "WEB-INF", "classes", "App.class"))).toBe(true);
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
  ])("rejects %s symlink targets atomically (legacy reject policy)", async (_kind, target) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-bad-link-"));
    try {
      const input = join(root, "input"); const out = join(root, "out"); mkdirSync(input); writeFileSync(join(input, "file"), "ok"); symlinkSync(target, join(input, "link"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(extractSourceArchive(archive, "source.tar", out, rejectPolicy)).rejects.toBeInstanceOf(SourceArchiveError);
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(".source-extract-"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["escape", "../../outside"],
    ["dangling", "missing"],
  ])("rejects %s ZIP symlink targets (legacy reject policy)", async (_kind, target) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-bad-zip-link-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "file"), "ok"); symlinkSync(target, join(input, "link"));
      const archive = join(root, "source.zip"); execSync(`zip -qry -y ${JSON.stringify(archive)} .`, { cwd: input });
      await expect(inspectSourceArchive(archive, "source.zip", rejectPolicy)).rejects.toBeInstanceOf(SourceArchiveError);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects symlink cycles (legacy reject policy)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-cycle-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "regular"), "ok"); symlinkSync("b", join(input, "a")); symlinkSync("a", join(input, "b"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", rejectPolicy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects over-deep symlink chains (legacy reject policy)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-deep-links-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "target"), "ok");
      for (let index = 0; index < 42; index += 1) symlinkSync(index === 41 ? "target" : `link-${index + 1}`, join(input, `link-${index}`));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      await expect(inspectSourceArchive(archive, "source.tar", rejectPolicy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an entry below a symlink parent without touching outside (legacy reject policy)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-parent-link-"));
    try {
      const input = join(root, "input"); const outside = join(root, "outside"); const out = join(root, "out"); mkdirSync(input); mkdirSync(outside);
      mkdirSync(join(input, "target")); writeFileSync(join(input, "target", "base"), "ok"); writeFileSync(join(input, "payload"), "attack"); writeFileSync(join(outside, "sentinel"), "keep"); symlinkSync("target", join(input, "dir"));
      const archive = join(root, "source.tar");
      execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} dir target && tar -rf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} --transform='s#^payload$#dir/pwn#' payload`);
      await expect(extractSourceArchive(archive, "source.tar", out, rejectPolicy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" });
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

describe("symlink policy drop mode (HALL-19)", () => {
  it("defaults to drop policy and reads the override from config", () => {
    expect(policy.symlink_policy).toBe("drop");
    expect(buildSourceArchivePolicy({}).symlink_policy).toBe("drop");
    expect(buildSourceArchivePolicy({ source_archive_symlink_policy: "reject" }).symlink_policy).toBe("reject");
    expect(buildSourceArchivePolicy({ source_archive_symlink_policy: "garbage" }).symlink_policy).toBe("drop");
    expect(rejectPolicy.symlink_policy).toBe("reject");
  });

  it.each([
    ["absolute_target", "/etc/passwd"],
    ["escapes_root", "../../outside"],
    ["dangling", "missing"],
  ])("drops %s symlinks with a structured warning (tar)", async (reason, target) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-"));
    try {
      const { archive } = makeArchiveWithLink(root, target);
      const inspected = await inspectSourceArchive(archive, "source.tar", policy);
      expect(inspected.warnings).toEqual([
        expect.objectContaining({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path: "link", reason }),
      ]);
      const out = join(root, "out");
      const extracted = await extractSourceArchive(archive, "source.tar", out, policy);
      expect(extracted.warnings).toHaveLength(1);
      expect(existsSync(join(out, "file"))).toBe(true);
      expect(existsSync(join(out, "link"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["absolute_target", "/etc/passwd"],
    ["escapes_root", "../../outside"],
    ["dangling", "missing"],
  ])("drops %s symlinks with a structured warning (zip)", async (reason, target) => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-zip-"));
    try {
      const archive = makeZipArchiveWithLink(root, target);
      const inspected = await inspectSourceArchive(archive, "source.zip", policy);
      expect(inspected.warnings).toEqual([
        expect.objectContaining({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path: "link", reason }),
      ]);
      const out = join(root, "out");
      await extractSourceArchive(archive, "source.zip", out, policy);
      expect(existsSync(join(out, "file"))).toBe(true);
      expect(existsSync(join(out, "link"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("drops symlink cycles with a warning instead of rejecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-cycle-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "regular"), "ok");
      symlinkSync("b", join(input, "a")); symlinkSync("a", join(input, "b"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      const inspected = await inspectSourceArchive(archive, "source.tar", policy);
      expect(inspected.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", reason: "cycle" }),
      ]));
      expect(inspected.warnings).toHaveLength(2);
      const out = join(root, "out");
      await extractSourceArchive(archive, "source.tar", out, policy);
      expect(existsSync(join(out, "regular"))).toBe(true);
      expect(existsSync(join(out, "a"))).toBe(false);
      expect(existsSync(join(out, "b"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("drops over-deep symlink chains with a warning instead of rejecting", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-deep-"));
    try {
      const input = join(root, "input"); mkdirSync(input); writeFileSync(join(input, "target"), "ok");
      for (let index = 0; index < 42; index += 1) symlinkSync(index === 41 ? "target" : `link-${index + 1}`, join(input, `link-${index}`));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      const inspected = await inspectSourceArchive(archive, "source.tar", policy);
      expect(inspected.warnings.length).toBeGreaterThan(0);
      expect(inspected.warnings.every((w) => w.code === "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED")).toBe(true);
      const out = join(root, "out");
      await extractSourceArchive(archive, "source.tar", out, policy);
      expect(existsSync(join(out, "target"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("drops a symlink parent and materializes real file entries through its path (HALL-19 bitfinite case)", async () => {
    // bitfinite-core shape: src/config/config -> ../build/src/config (dangling).
    // In drop mode the link vanishes; entries under it materialize as real dirs.
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-parent-"));
    try {
      const input = join(root, "input");
      mkdirSync(join(input, "src", "config"), { recursive: true });
      writeFileSync(join(input, "src", "config", "real.txt"), "ok");
      symlinkSync("../build/src/config", join(input, "src", "config", "config"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      const inspected = await inspectSourceArchive(archive, "source.tar", policy);
      expect(inspected.warnings).toEqual([
        expect.objectContaining({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path: "src/config/config", reason: "dangling" }),
      ]);
      const out = join(root, "out");
      await extractSourceArchive(archive, "source.tar", out, policy);
      expect(readFileSync(join(out, "src", "config", "real.txt"), "utf-8")).toBe("ok");
      expect(existsSync(join(out, "src", "config", "config"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still hard-rejects unsafe entry paths under drop policy (zip-slip surface unchanged)", async () => {
    // Build tars by hand (the tar CLI refuses ../ or /abs member names):
    // two safe dir headers + one evil header whose name field is patched and
    // checksums recomputed — the exact shape a malicious packer would emit.
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-unsafe-"));
    try {
      const input = join(root, "input"); mkdirSync(join(input, "safe"), { recursive: true }); writeFileSync(join(input, "safe", "file"), "ok");
      const base = join(root, "base.tar");
      execSync(`tar -cf ${JSON.stringify(base)} -C ${JSON.stringify(input)} .`);
      const baseBuf = readFileSync(base);
      const dirHeaders = baseBuf.subarray(0, 1024); // "./" + "./safe/" headers
      const fileHeader = baseBuf.subarray(1024, 1024 + 512);
      const fileData = baseBuf.subarray(1024 + 512, 1024 + 1024);
      const build = (entryName: string): string => {
        const header = Buffer.from(fileHeader);
        header.fill(0, 0, 100); header.write(entryName, 0, 100, "utf8");
        header.fill(0x20, 148, 156);
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
        const archive = join(root, `${entryName.replace(/[^a-z]/gi, "_")}.tar`);
        writeFileSync(archive, Buffer.concat([dirHeaders, header, fileData, Buffer.alloc(1024)]));
        return archive;
      };
      for (const entryName of ["../evil", "/abs/evil"]) {
        await expect(inspectSourceArchive(build(entryName), "source.tar", policy))
          .rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSAFE_PATH" });
      }
      // Backslash in entry path: the zip CLI stores it verbatim — reuse it.
      const zipRoot = mkdtempSync(join(tmpdir(), "source-archive-drop-unsafe-zip-"));
      try {
        const zipInput = join(zipRoot, "input"); mkdirSync(zipInput); writeFileSync(join(zipInput, "a\\b"), "ok");
        const zipArchive = join(zipRoot, "source.zip");
        execSync(`zip -qry ${JSON.stringify(zipArchive)} .`, { cwd: zipInput });
        await expect(inspectSourceArchive(zipArchive, "source.zip", policy)).rejects.toMatchObject({ code: "ERR_SOURCE_ARCHIVE_UNSAFE_PATH" });
      } finally { rmSync(zipRoot, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("restores fail-fast behavior under symlink_policy=reject (regression guard)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-reject-mode-"));
    try {
      const { archive } = makeArchiveWithLink(root, "/etc/passwd");
      await expect(inspectSourceArchive(archive, "source.tar", rejectPolicy)).rejects.toBeInstanceOf(SourceArchiveError);
      const out = join(root, "out");
      await expect(extractSourceArchive(archive, "source.tar", out, rejectPolicy)).rejects.toBeInstanceOf(SourceArchiveError);
      expect(existsSync(out)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps safe relative symlinks warning-free in drop mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-drop-clean-"));
    try {
      const input = join(root, "input"); mkdirSync(join(input, "server"), { recursive: true });
      writeFileSync(join(input, "server", "LICENSE"), "license\n"); symlinkSync("server/LICENSE", join(input, "LICENSE.enterprise"));
      const archive = join(root, "source.tar"); execSync(`tar -cf ${JSON.stringify(archive)} -C ${JSON.stringify(input)} .`);
      const inspected = await inspectSourceArchive(archive, "source.tar", policy);
      expect(inspected.warnings).toEqual([]);
      const out = join(root, "out");
      await extractSourceArchive(archive, "source.tar", out, policy);
      expect(lstatSync(join(out, "LICENSE.enterprise")).isSymbolicLink()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("warnings surfacing (HALL-19)", () => {
  it("upload gate response carries structured warnings; scheduler/report-worker persist them", async () => {
    // Contract-level assertions mirroring the existing caller-contract test:
    // the route must return warnings in the 201 body, and both extraction
    // call sites must merge warnings into task metadata + log them.
    const routes = readFileSync(join(process.cwd(), "src/features/files/routes.ts"), "utf8");
    expect(routes).toContain("sourceArchiveWarnings = (await inspectSourceArchive(tmpPath, file.name, policy)).warnings");
    expect(routes).toContain("return c.json({ task, warnings: sourceArchiveWarnings }, 201)");

    const scheduler = readFileSync(join(process.cwd(), "src/features/workers/scheduler.ts"), "utf8");
    expect(scheduler).toContain("const { warnings: sourceArchiveWarnings = [] } = await extractSourceArchive(");
    expect(scheduler).toContain("mergeTaskMetadata(task.id, { source_archive_warnings: sourceArchiveWarnings })");

    const reportWorker = readFileSync(join(process.cwd(), "src/features/reports/report-worker.ts"), "utf8");
    expect(reportWorker).toContain("mergeTaskMetadata(task.id, { source_archive_warnings: warnings })");
  });
});

describe("review fixes (HALL-19 PR #47 review)", () => {
  /** Minimal store-only zip builder: raw name/data bytes + external attr (symlink support). */
  function writeRawZipWithAttr(outPath: string, entries: Array<{ name: string; data: Buffer; externalAttr?: number }>): void {
    const crcTable = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
      return table;
    })();
    const crc32 = (buf: Buffer): number => {
      let c = 0xffffffff;
      for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const { name, data, externalAttr } of entries) {
      const nameBuf = Buffer.from(name, "utf8");
      const crc = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8); // store
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      parts.push(local, nameBuf, data);

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      cen.writeUInt16LE(20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0, 8);
      cen.writeUInt16LE(0, 10);
      cen.writeUInt16LE(0, 12);
      cen.writeUInt16LE(0, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(data.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(nameBuf.length, 28);
      cen.writeUInt16LE(0, 30); // extra len
      cen.writeUInt16LE(0, 32); // comment len
      cen.writeUInt16LE(0, 34); // disk number
      cen.writeUInt16LE(0, 36); // internal attrs
      cen.writeUInt32LE((externalAttr ?? (0o100644 << 16)) >>> 0, 38); // external attrs (unix mode in high 16)
      cen.writeUInt32LE(offset, 42);
      central.push(cen, nameBuf);
      offset += local.length + nameBuf.length + data.length;
    }
    const centralStart = offset;
    const centralBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    writeFileSync(outPath, Buffer.concat([...parts, centralBuf, end]));
  }

  it("drops a too-long zip symlink target with a warning (parity with tar, review #1)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-zip-long-target-"));
    try {
      const archive = join(root, "big.zip");
      writeRawZipWithAttr(archive, [
        { name: "file", data: Buffer.from("ok") },
        { name: "biglink", data: Buffer.alloc(5000, 0x78), externalAttr: (0o120000 << 16) | 0o644 },
      ]);
      const inspected = await inspectSourceArchive(archive, "big.zip", policy);
      expect(inspected.warnings).toEqual([
        expect.objectContaining({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path: "biglink", reason: "target_too_long" }),
      ]);
      const out = join(root, "out");
      const extracted = await extractSourceArchive(archive, "big.zip", out, policy);
      expect(extracted.warnings).toHaveLength(1);
      expect(existsSync(join(out, "file"))).toBe(true);
      expect(existsSync(join(out, "biglink"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still rejects a too-long zip symlink target under reject policy (review #1 regression guard)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-zip-long-target-reject-"));
    try {
      const archive = join(root, "big.zip");
      writeRawZipWithAttr(archive, [
        { name: "file", data: Buffer.from("ok") },
        { name: "biglink", data: Buffer.alloc(5000, 0x78), externalAttr: (0o120000 << 16) | 0o644 },
      ]);
      await expect(inspectSourceArchive(archive, "big.zip", rejectPolicy)).rejects.toMatchObject({
        code: "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY",
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("emits exactly one warning for an undecodable zip link target (review #2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "source-archive-zip-bad-utf8-"));
    try {
      const archive = join(root, "bad.zip");
      writeRawZipWithAttr(archive, [
        { name: "file", data: Buffer.from("ok") },
        { name: "badlink", data: Buffer.from([0xff, 0xfe, 0x80]), externalAttr: (0o120000 << 16) | 0o644 },
      ]);
      const inspected = await inspectSourceArchive(archive, "bad.zip", policy);
      // One warning only — the parse loop must not double-drop an already
      // dropped entry (target_not_utf8 + dangling would be contradictory).
      expect(inspected.warnings).toHaveLength(1);
      expect(inspected.warnings[0]).toMatchObject({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
