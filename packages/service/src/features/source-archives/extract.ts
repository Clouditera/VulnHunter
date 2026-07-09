import { createWriteStream, rmSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import yauzl from "yauzl";
import * as tar from "tar";
import { detectSourceArchive, type SourceArchiveFormat } from "./detect.js";
import { SourceArchiveError } from "./errors.js";
import { SOURCE_ARCHIVE_MAX_FILES, maxExtractedBytes, type SourceArchivePolicy } from "./policy.js";

interface InspectState {
  files: number;
  bytes: number;
}

function normalizeEntryPath(entryPath: string): string {
  const raw = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", "Archive contains an empty path");
  if (raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:\//.test(raw)) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains an unsafe absolute path: ${entryPath}`);
  }
  const normalized = posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains path traversal: ${entryPath}`);
  }
  return normalized.replace(/\/$/, "");
}

function bumpState(state: InspectState, bytes: number, policy: SourceArchivePolicy): void {
  state.files += 1;
  state.bytes += Math.max(0, bytes);
  if (state.files > SOURCE_ARCHIVE_MAX_FILES) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_TOO_MANY_FILES", `Archive contains too many files (max ${SOURCE_ARCHIVE_MAX_FILES})`);
  }
  const extractedLimit = maxExtractedBytes(policy);
  if (state.bytes > extractedLimit) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_EXTRACTED_TOO_LARGE", "Archive extracted content exceeds the safety limit");
  }
}

function zipEntryMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0o170000;
}

function ensureZipEntryAllowed(entry: yauzl.Entry, policy: SourceArchivePolicy, state: InspectState): { path: string; isDir: boolean } {
  const isDir = entry.fileName.endsWith("/");
  const mode = zipEntryMode(entry);
  const isRegular = mode === 0 || mode === 0o100000;
  const isDirectory = mode === 0o040000;
  if (!isDir && !isRegular) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry: ${entry.fileName}`);
  }
  if (isDir && mode !== 0 && !isDirectory) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported directory entry: ${entry.fileName}`);
  }
  const safePath = normalizeEntryPath(entry.fileName);
  if (!isDir) bumpState(state, entry.uncompressedSize ?? 0, policy);
  return { path: safePath, isDir };
}

async function inspectZip(archivePath: string, policy: SourceArchivePolicy): Promise<void> {
  const state: InspectState = { files: 0, bytes: 0 };
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        try {
          ensureZipEntryAllowed(entry, policy, state);
          zipfile.readEntry();
        } catch (e) {
          zipfile.close();
          reject(e);
        }
      });
      zipfile.on("end", () => {
        if (state.files === 0) reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Archive contains no regular files"));
        else resolve();
      });
      zipfile.on("error", () => reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Corrupt ZIP archive")));
    });
  });
}

function ensureTarEntryAllowed(entry: any, policy: SourceArchivePolicy, state: InspectState): { path: string; isDir: boolean } {
  const entryPath = String(entry.path ?? "");
  if (entryPath === "." || entryPath === "./") return { path: "", isDir: true };
  const type = entry.type as string;
  const isDir = type === "Directory";
  const isFile = type === "File" || type === "OldFile" || type === "ContiguousFile";
  if (!isDir && !isFile) {
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry type ${type}: ${entry.path}`);
  }
  const safePath = normalizeEntryPath(entryPath);
  if (isFile) bumpState(state, Number(entry.size ?? 0), policy);
  return { path: safePath, isDir };
}

async function inspectTar(archivePath: string, policy: SourceArchivePolicy): Promise<void> {
  const state: InspectState = { files: 0, bytes: 0 };
  let firstError: SourceArchiveError | null = null;
  try {
    await tar.t({
      file: archivePath,
      onentry(entry: any) {
        if (!firstError) {
          try { ensureTarEntryAllowed(entry, policy, state); }
          catch (err) { firstError = err instanceof SourceArchiveError ? err : new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive"); }
        }
        entry.resume?.();
      },
    });
  } catch (err) {
    if (firstError) throw firstError;
    if (err instanceof SourceArchiveError) throw err;
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive");
  }
  if (firstError) throw firstError;
  if (state.files === 0) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Archive contains no regular files");
}

export async function inspectSourceArchive(archivePath: string, filename: string, policy: SourceArchivePolicy): Promise<void> {
  const detected = detectSourceArchive(filename);
  if (!detected) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", "Unsupported source archive format");
  if (detected.format === "zip") return inspectZip(archivePath, policy);
  return inspectTar(archivePath, policy);
}

async function extractZip(archivePath: string, destDir: string, policy: SourceArchivePolicy): Promise<void> {
  const state: InspectState = { files: 0, bytes: 0 };
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
      const next = () => zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        let allowed: { path: string; isDir: boolean };
        try {
          allowed = ensureZipEntryAllowed(entry, policy, state);
        } catch (e) {
          zipfile.close(); reject(e); return;
        }
        const target = join(destDir, allowed.path);
        if (allowed.isDir) {
          mkdir(target, { recursive: true }).then(next, (e) => { zipfile.close(); reject(e); });
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { zipfile.close(); reject(streamErr ?? new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read ZIP entry")); return; }
          mkdir(dirname(target), { recursive: true }).then(() => {
            const out = createWriteStream(target, { mode: 0o644 });
            stream.pipe(out);
            out.on("finish", () => { chmod(target, 0o644).catch(() => {}).finally(next); });
            out.on("error", (e) => { zipfile.close(); reject(e); });
            stream.on("error", (e) => { zipfile.close(); reject(e); });
          }, (e) => { zipfile.close(); reject(e); });
        });
      });
      zipfile.on("end", () => resolve());
      zipfile.on("error", () => reject(new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Corrupt ZIP archive")));
      next();
    });
  });
}

async function extractTar(archivePath: string, destDir: string, policy: SourceArchivePolicy): Promise<void> {
  const state: InspectState = { files: 0, bytes: 0 };
  let firstError: SourceArchiveError | null = null;
  try {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      preserveOwner: false,
      noChmod: true,
      filter(_path: string, entry: any) {
        if (firstError) return false;
        try {
          const allowed = ensureTarEntryAllowed(entry, policy, state);
          return !!allowed.path;
        } catch (err) {
          firstError = err instanceof SourceArchiveError ? err : new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot extract TAR archive");
          return false;
        }
      },
    });
  } catch (err) {
    if (firstError) throw firstError;
    if (err instanceof SourceArchiveError) throw err;
    throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot extract TAR archive");
  }
  if (firstError) throw firstError;
}

export async function extractSourceArchive(archivePath: string, filename: string, destDir: string, policy: SourceArchivePolicy): Promise<void> {
  const detected = detectSourceArchive(filename);
  if (!detected) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", "Unsupported source archive format");
  try {
    await mkdir(destDir, { recursive: true });
    if (detected.format === "zip") await extractZip(archivePath, destDir, policy);
    else await extractTar(archivePath, destDir, policy);
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true });
    throw err;
  }
}

export function archiveFormatFromFilename(filename: string): SourceArchiveFormat | null {
  return detectSourceArchive(filename)?.format ?? null;
}
