import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeArchiveBytes, decodeTextFileContent } from "../../src/features/source-archives/charset.js";
import { extractSourceArchive } from "../../src/features/source-archives/extract.js";
import { buildSourceArchivePolicy } from "../../src/features/source-archives/policy.js";
import { classifyCodeFileBuffer } from "../../src/features/workspace/code-viewer.js";

const policy = buildSourceArchivePolicy({ source_archive_upload_max_mb: 500 });

/** Minimal store-only ZIP with raw (possibly non-UTF-8) entry name bytes. */
function writeRawZip(outPath: string, entries: Array<{ name: Buffer; data: Buffer }>): void {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags — NO UTF-8 bit
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14); // crc placeholder
    // crc32
    const crc = crc32(data);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);

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
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + data.length;
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

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe("charset decode helpers", () => {
  it("keeps valid UTF-8 without falling back", () => {
    expect(decodeArchiveBytes(Buffer.from("你好 UTF-8", "utf8"))).toBe("你好 UTF-8");
    expect(decodeTextFileContent(Buffer.from("// 注释\n", "utf8"))).toBe("// 注释\n");
  });

  it("decodes GBK bytes when UTF-8 fatal fails", () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK
    expect(decodeArchiveBytes(gbk)).toBe("你好");
    expect(decodeTextFileContent(gbk)).toBe("你好");
  });
});

describe("GBK zip entry names + content", () => {
  it("extracts GBK entry names to correct Unicode paths and keeps raw file bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "gbk-zip-"));
    try {
      const zipPath = join(root, "gbk.zip");
      // 中文目录/说明.txt + content in GBK (Node Buffer has no 'gbk' codec — hardcode bytes)
      const dirGbk = Buffer.from([214, 208, 206, 196, 196, 191, 194, 188, 47]);
      const fileGbk = Buffer.from([214, 208, 206, 196, 196, 191, 194, 188, 47, 203, 181, 195, 247, 46, 116, 120, 116]);
      const contentGbk = Buffer.from([47, 47, 32, 213, 226, 202, 199, 71, 66, 75, 215, 162, 202, 205, 10, 112, 117, 98, 108, 105, 99, 32, 99, 108, 97, 115, 115, 32, 68, 101, 109, 111, 32, 123, 125, 10]);
      writeRawZip(zipPath, [
        { name: dirGbk, data: Buffer.alloc(0) },
        { name: fileGbk, data: contentGbk },
      ]);

      const dest = join(root, "out");
      await extractSourceArchive(zipPath, "gbk.zip", dest, policy);

      // Directory and file names are correct Unicode on disk
      const top = readdirSync(dest);
      expect(top).toContain("中文目录");
      const files = readdirSync(join(dest, "中文目录"));
      expect(files).toContain("说明.txt");

      // Disk bytes remain GBK (no re-encode)
      const onDisk = readFileSync(join(dest, "中文目录", "说明.txt"));
      expect(onDisk.equals(contentGbk)).toBe(true);

      // Viewer decodes content to readable Unicode
      const viewed = await classifyCodeFileBuffer(onDisk, "说明.txt");
      expect(viewed.type).toBe("text");
      expect(viewed.content).toContain("这是GBK注释");
      expect(viewed.content).toContain("public class Demo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("UTF-8 zip still extracts correctly (zero regression)", async () => {
    const root = mkdtempSync(join(tmpdir(), "utf8-zip-"));
    try {
      const src = join(root, "src");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(src, "docs"), { recursive: true });
      writeFileSync(join(src, "docs", "readme.txt"), "你好 UTF-8\n", "utf8");
      const zipPath = join(root, "utf8.zip");
      execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: src });

      const dest = join(root, "out");
      await extractSourceArchive(zipPath, "utf8.zip", dest, policy);
      expect(existsSync(join(dest, "docs", "readme.txt"))).toBe(true);
      expect(readFileSync(join(dest, "docs", "readme.txt"), "utf8")).toContain("你好 UTF-8");
      const viewed = await classifyCodeFileBuffer(readFileSync(join(dest, "docs", "readme.txt")), "readme.txt");
      expect(viewed.content).toContain("你好 UTF-8");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("QA GBK sample archive", () => {
  const sample = "/tmp/e2e/gbk-repro/gbk-chinese-sample.zip";
  const utf8Sample = "/tmp/e2e/gbk-repro/utf8-chinese-sample.zip";

  it("extracts QA GBK sample with Chinese paths and readable content", async () => {
    if (!existsSync(sample)) return;
    const root = mkdtempSync(join(tmpdir(), "gbk-qa-"));
    try {
      const dest = join(root, "out");
      await extractSourceArchive(sample, "gbk-chinese-sample.zip", dest, policy);
      const names = readdirSync(dest);
      expect(names.some((n) => /[\u4e00-\u9fff]/.test(n))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("UTF-8 QA sample extracts without error", async () => {
    if (!existsSync(utf8Sample)) return;
    const root = mkdtempSync(join(tmpdir(), "utf8-qa-"));
    try {
      const dest = join(root, "out");
      await extractSourceArchive(utf8Sample, "utf8-chinese-sample.zip", dest, policy);
      expect(readdirSync(dest).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
