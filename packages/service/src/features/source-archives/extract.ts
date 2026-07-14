import { createWriteStream, existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, symlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { TextDecoder } from "node:util";
import yauzl from "yauzl";
import * as tar from "tar";
import { detectSourceArchive, type SourceArchiveFormat } from "./detect.js";
import { SourceArchiveError } from "./errors.js";
import { SOURCE_ARCHIVE_MAX_FILES, maxExtractedBytes, type SourceArchivePolicy } from "./policy.js";

interface InspectState { files: number; regularFiles: number; bytes: number }
type EntryKind = "file" | "directory" | "symlink";
interface ManifestEntry { path: string; kind: EntryKind; size: number; linkTarget?: string; resolvedTarget?: string }
interface ArchiveManifest { entries: ManifestEntry[]; byPath: Map<string, ManifestEntry> }
const MAX_LINK_BYTES = 4096;
const MAX_LINK_DEPTH = 40;

function archiveError(code: "ERR_SOURCE_ARCHIVE_UNSAFE_PATH" | "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" | "ERR_SOURCE_ARCHIVE_CORRUPT", message: string): SourceArchiveError {
  return new SourceArchiveError(code, message);
}

function normalizeEntryPath(entryPath: string): string {
  if (entryPath.includes("\\") || entryPath.includes("\0")) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains an unsafe path: ${entryPath}`);
  const raw = entryPath.replace(/^\.\//, "").replace(/\/$/, "");
  if (!raw || raw === ".") throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", "Archive contains an empty path");
  if (raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains an unsafe absolute path: ${entryPath}`);
  if (raw.split("/").includes("..")) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains path traversal: ${entryPath}`);
  const normalized = posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains path traversal: ${entryPath}`);
  if (normalized !== raw) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains a non-canonical path: ${entryPath}`);
  return normalized;
}

function bumpState(state: InspectState, bytes: number, regular: boolean, policy: SourceArchivePolicy): void {
  state.files += 1; state.bytes += Math.max(0, bytes); if (regular) state.regularFiles += 1;
  if (state.files > SOURCE_ARCHIVE_MAX_FILES) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_TOO_MANY_FILES", `Archive contains too many files (max ${SOURCE_ARCHIVE_MAX_FILES})`);
  if (state.bytes > maxExtractedBytes(policy)) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_EXTRACTED_TOO_LARGE", "Archive extracted content exceeds the safety limit");
}

function resolveLinkTarget(path: string, target: string): string {
  if (!target || target.length > MAX_LINK_BYTES || target.includes("\\") || target.includes("\0") || target.startsWith("/") || target.startsWith("//") || /^[A-Za-z]:/.test(target)) {
    throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive contains an unsafe symbolic link: ${path}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", `Archive symbolic link escapes the source root: ${path}`);
  return resolved;
}

function validateManifest(entries: ManifestEntry[]): ArchiveManifest {
  const byPath = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains a duplicate path: ${entry.path}`);
    byPath.set(entry.path, entry);
  }
  const implicitDirs = new Set<string>();
  for (const entry of entries) {
    let parent = posix.dirname(entry.path);
    while (parent !== ".") { implicitDirs.add(parent); parent = posix.dirname(parent); }
  }
  for (const entry of entries) {
    let parent = posix.dirname(entry.path);
    while (parent !== ".") {
      const ancestor = byPath.get(parent);
      if (ancestor && ancestor.kind !== "directory") throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive entry has a non-directory parent: ${entry.path}`);
      parent = posix.dirname(parent);
    }
    if (entry.kind === "symlink") entry.resolvedTarget = resolveLinkTarget(entry.path, entry.linkTarget ?? "");
  }
  for (const entry of entries.filter((item) => item.kind === "symlink")) {
    let target = entry.resolvedTarget!;
    const seen = new Set<string>([entry.path]);
    for (let depth = 0; depth <= MAX_LINK_DEPTH; depth += 1) {
      if (implicitDirs.has(target) && !byPath.has(target)) break;
      const targetEntry = byPath.get(target);
      if (!targetEntry) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains a dangling symbolic link: ${entry.path}`);
      if (targetEntry.kind !== "symlink") break;
      if (seen.has(target)) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains a symbolic link cycle: ${entry.path}`);
      seen.add(target);
      if (depth === MAX_LINK_DEPTH) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive symbolic link chain is too deep: ${entry.path}`);
      target = targetEntry.resolvedTarget!;
    }
  }
  return { entries, byPath };
}

function zipEntryMode(entry: yauzl.Entry): number { return (entry.externalFileAttributes >>> 16) & 0o170000; }
function readZipEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => zipfile.openReadStream(entry, (err, stream) => {
    if (err || !stream) return reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read ZIP entry"));
    const chunks: Buffer[] = []; let bytes = 0;
    stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= MAX_LINK_BYTES) chunks.push(chunk); });
    stream.on("end", () => bytes > MAX_LINK_BYTES ? reject(archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive symbolic link target is too long: ${entry.fileName}`)) : resolve(Buffer.concat(chunks)));
    stream.on("error", () => reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read ZIP entry")));
  }));
}

async function buildZipManifest(archivePath: string, policy: SourceArchivePolicy): Promise<ArchiveManifest> {
  const state: InspectState = { files: 0, regularFiles: 0, bytes: 0 }; const entries: ManifestEntry[] = [];
  await new Promise<void>((resolve, reject) => yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
    if (err || !zipfile) return reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
    let stopped = false; const stop = (error: unknown) => { if (!stopped) { stopped = true; zipfile.close(); reject(error); } };
    zipfile.on("entry", async (entry) => {
      try {
        const path = normalizeEntryPath(entry.fileName); const mode = zipEntryMode(entry); const namedDir = entry.fileName.endsWith("/");
        let kind: EntryKind;
        if (namedDir && (mode === 0 || mode === 0o040000)) kind = "directory";
        else if (!namedDir && (mode === 0 || mode === 0o100000)) kind = "file";
        else if (!namedDir && mode === 0o120000) kind = "symlink";
        else throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry: ${entry.fileName}`);
        if (kind === "directory") entries.push({ path, kind, size: 0 });
        else if (kind === "file") { bumpState(state, entry.uncompressedSize ?? 0, true, policy); entries.push({ path, kind, size: entry.uncompressedSize ?? 0 }); }
        else {
          bumpState(state, entry.uncompressedSize ?? 0, false, policy); const raw = await readZipEntry(zipfile, entry); let target: string;
          try { target = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive symbolic link target is not UTF-8: ${entry.fileName}`); }
          entries.push({ path, kind, size: raw.length, linkTarget: target });
        }
        if (!stopped) zipfile.readEntry();
      } catch (error) { stop(error); }
    });
    zipfile.on("end", () => { if (!stopped) { stopped = true; resolve(); } });
    zipfile.on("error", () => stop(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Corrupt ZIP archive")));
    zipfile.readEntry();
  }));
  if (state.regularFiles === 0) throw archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Archive contains no regular files");
  return validateManifest(entries);
}

async function buildTarManifest(archivePath: string, policy: SourceArchivePolicy): Promise<ArchiveManifest> {
  const state: InspectState = { files: 0, regularFiles: 0, bytes: 0 }; const entries: ManifestEntry[] = []; let firstError: SourceArchiveError | null = null;
  try {
    await tar.t({ file: archivePath, onentry(entry: any) {
      if (!firstError) try {
        const raw = String(entry.path ?? ""); if (raw === "." || raw === "./") { entry.resume?.(); return; }
        const path = normalizeEntryPath(raw); const type = String(entry.type ?? ""); let kind: EntryKind;
        if (type === "Directory") kind = "directory";
        else if (["File", "OldFile", "ContiguousFile"].includes(type)) kind = "file";
        else if (type === "SymbolicLink") kind = "symlink";
        else throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry type ${type}: ${raw}`);
        if (kind === "directory") entries.push({ path, kind, size: 0 });
        else if (kind === "file") { bumpState(state, Number(entry.size ?? 0), true, policy); entries.push({ path, kind, size: Number(entry.size ?? 0) }); }
        else { const target = String(entry.linkpath ?? ""); bumpState(state, Buffer.byteLength(target), false, policy); entries.push({ path, kind, size: Buffer.byteLength(target), linkTarget: target }); }
      } catch (error) { firstError = error instanceof SourceArchiveError ? error : archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive"); }
      entry.resume?.();
    } });
  } catch (error) { if (firstError) throw firstError; throw error instanceof SourceArchiveError ? error : archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive"); }
  if (firstError) throw firstError;
  if (state.regularFiles === 0) throw archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Archive contains no regular files");
  return validateManifest(entries);
}

async function buildManifest(archivePath: string, filename: string, policy: SourceArchivePolicy): Promise<{ format: SourceArchiveFormat; manifest: ArchiveManifest }> {
  const detected = detectSourceArchive(filename); if (!detected) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", "Unsupported source archive format");
  return { format: detected.format, manifest: detected.format === "zip" ? await buildZipManifest(archivePath, policy) : await buildTarManifest(archivePath, policy) };
}

export async function inspectSourceArchive(archivePath: string, filename: string, policy: SourceArchivePolicy): Promise<void> { await buildManifest(archivePath, filename, policy); }

async function extractZip(archivePath: string, destDir: string, manifest: ArchiveManifest): Promise<void> {
  await new Promise<void>((resolve, reject) => yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
    if (err || !zipfile) return reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
    const next = () => zipfile.readEntry();
    zipfile.on("entry", (entry) => {
      let path: string; try { path = normalizeEntryPath(entry.fileName); } catch (error) { zipfile.close(); reject(error); return; }
      const item = manifest.byPath.get(path); if (!item) { zipfile.close(); reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "ZIP manifest changed during extraction")); return; }
      const target = join(destDir, path);
      if (item.kind === "directory") { mkdir(target, { recursive: true, mode: 0o755 }).then(next, reject); return; }
      if (item.kind === "symlink") { next(); return; }
      zipfile.openReadStream(entry, (streamErr, stream) => {
        if (streamErr || !stream) { zipfile.close(); reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read ZIP entry")); return; }
        mkdir(dirname(target), { recursive: true, mode: 0o755 }).then(() => {
          const out = createWriteStream(target, { flags: "wx", mode: 0o644 }); stream.pipe(out);
          out.on("finish", () => chmod(target, 0o644).then(next, reject)); out.on("error", reject); stream.on("error", reject);
        }, reject);
      });
    });
    zipfile.on("end", resolve); zipfile.on("error", () => reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Corrupt ZIP archive"))); next();
  }));
  await createLinks(destDir, manifest);
}

async function extractTar(archivePath: string, destDir: string, manifest: ArchiveManifest): Promise<void> {
  try {
    await tar.x({ file: archivePath, cwd: destDir, preserveOwner: false, noChmod: true, strict: true, filter(path: string) {
      if (path === "." || path === "./") return false;
      const normalized = normalizeEntryPath(path); const item = manifest.byPath.get(normalized); return item?.kind === "file" || item?.kind === "directory";
    } });
  } catch (error) { throw error instanceof SourceArchiveError ? error : archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot extract TAR archive"); }
  await createLinks(destDir, manifest);
}

async function createLinks(destDir: string, manifest: ArchiveManifest): Promise<void> {
  for (const item of manifest.entries.filter((entry) => entry.kind === "symlink")) {
    const target = join(destDir, item.path); await mkdir(dirname(target), { recursive: true, mode: 0o755 }); await symlink(item.linkTarget!, target);
  }
}

export async function extractSourceArchive(archivePath: string, filename: string, destDir: string, policy: SourceArchivePolicy): Promise<void> {
  const parent = dirname(destDir); await mkdir(parent, { recursive: true });
  if (existsSync(destDir)) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", "Extraction destination already exists");
  const tempDir = await mkdtemp(join(parent, ".source-extract-"));
  try {
    const { format, manifest } = await buildManifest(archivePath, filename, policy);
    if (format === "zip") await extractZip(archivePath, tempDir, manifest); else await extractTar(archivePath, tempDir, manifest);
    await rename(tempDir, destDir);
  } catch (error) { rmSync(tempDir, { recursive: true, force: true }); throw error; }
}

export function archiveFormatFromFilename(filename: string): SourceArchiveFormat | null { return detectSourceArchive(filename)?.format ?? null; }
