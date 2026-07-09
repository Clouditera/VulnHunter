import yauzl from "yauzl";
import * as tar from "tar";
import { detectSourceArchive } from "./detect.js";
import { SourceArchiveError } from "./errors.js";

export interface ArchiveEntry {
  path: string;
  isDir: boolean;
}

function normalizeReaderPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
}

export async function listArchiveEntries(archivePath: string, filename: string): Promise<ArchiveEntry[]> {
  const detected = detectSourceArchive(filename);
  if (!detected) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", "Unsupported source archive format");
  if (detected.format === "zip") return listZipEntries(archivePath);
  return listTarEntries(archivePath);
}

function listZipEntries(zipPath: string): Promise<ArchiveEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ArchiveEntry[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        const isDir = entry.fileName.endsWith("/");
        const path = normalizeReaderPath(entry.fileName);
        if (path) entries.push({ path, isDir });
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", () => reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Corrupt ZIP archive")));
    });
  });
}

async function listTarEntries(tarPath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  try {
    await tar.t({
      file: tarPath,
      onentry(entry: any) {
        const type = entry.type as string;
        const isDir = type === "Directory";
        const isFile = type === "File" || type === "OldFile" || type === "ContiguousFile";
        const path = normalizeReaderPath(String(entry.path ?? ""));
        if (path && (isDir || isFile)) entries.push({ path, isDir });
        entry.resume?.();
      },
    });
    return entries;
  } catch {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive");
  }
}

export async function readArchiveFile(archivePath: string, filename: string, targetPath: string): Promise<Buffer> {
  const detected = detectSourceArchive(filename);
  if (!detected) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", "Unsupported source archive format");
  if (detected.format === "zip") return readZipFile(archivePath, targetPath);
  return readTarFile(archivePath, targetPath);
}

function matchesTarget(entryPath: string, targetPath: string): boolean {
  const entry = normalizeReaderPath(entryPath);
  const target = normalizeReaderPath(targetPath);
  return entry === target || entry.endsWith(`/${target}`);
}

function readZipFile(zipPath: string, targetPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (matchesTarget(entry.fileName, targetPath)) {
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) { zipfile.close(); reject(streamErr ?? new Error("Cannot open ZIP entry")); return; }
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => { zipfile.close(); resolve(Buffer.concat(chunks)); });
            stream.on("error", (e) => { zipfile.close(); reject(e); });
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on("end", () => reject(new Error(`File not found in archive: ${targetPath}`)));
      zipfile.on("error", reject);
    });
  });
}

async function readTarFile(tarPath: string, targetPath: string): Promise<Buffer> {
  let found: Buffer | null = null;
  try {
    await tar.t({
      file: tarPath,
      onentry(entry: any) {
        if (found || !matchesTarget(String(entry.path ?? ""), targetPath)) {
          entry.resume?.();
          return;
        }
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => { found = Buffer.concat(chunks); });
      },
    });
  } catch {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive");
  }
  if (!found) throw new Error(`File not found in archive: ${targetPath}`);
  return found;
}
