import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, symlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import yauzl from "yauzl";
import * as tar from "tar";
import { detectSourceArchive, type SourceArchiveFormat } from "./detect.js";
import { decodeArchiveBytes, decodeTarEntryPath, decodeZipEntryName } from "./charset.js";
import { SourceArchiveError, type SourceArchiveWarning, type SourceArchiveWarningReason } from "./errors.js";
import { SOURCE_ARCHIVE_MAX_FILES, maxExtractedBytes, type SourceArchivePolicy } from "./policy.js";

interface InspectState { entries: number; regularFiles: number; bytes: number }
type EntryKind = "file" | "directory" | "symlink";
interface ManifestEntry { path: string; kind: EntryKind; size: number; linkTarget?: string; resolvedTarget?: string; dropped?: boolean }
interface ArchiveManifest { entries: ManifestEntry[]; byPath: Map<string, ManifestEntry>; warnings: SourceArchiveWarning[] }
const MAX_LINK_BYTES = 4096;
const MAX_LINK_DEPTH = 40;
// Drop reasons are plain strings too — discriminate them from resolved paths
// by membership, since typeof cannot tell "escapes_root" from a real path.
const LINK_DROP_REASONS: ReadonlySet<string> = new Set([
  "absolute_target",
  "escapes_root",
  "dangling",
  "cycle",
  "too_deep",
  "target_too_long",
  "target_not_utf8",
]);

function isDropReason(value: string | SourceArchiveWarningReason): value is SourceArchiveWarningReason {
  return LINK_DROP_REASONS.has(value);
}

function archiveError(code: "ERR_SOURCE_ARCHIVE_UNSAFE_PATH" | "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" | "ERR_SOURCE_ARCHIVE_CORRUPT", message: string): SourceArchiveError {
  return new SourceArchiveError(code, message);
}

/** Fish 2026-07-30: Chinese + point out the specific entry for path/symlink issues. */
function zhUnsafePath(entryPath: string): string {
  return `压缩包包含不安全的路径或链接（可能导致路径穿越）：${entryPath}。请删除该条目后重新打包上传。`;
}

function normalizeEntryPath(entryPath: string): string {
  if (entryPath.includes("\\") || entryPath.includes("\0")) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entryPath));
  const raw = entryPath.replace(/^\.\//, "").replace(/\/$/, "");
  if (!raw || raw === ".") throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entryPath || "(empty)"));
  if (raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entryPath));
  if (raw.split("/").includes("..")) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entryPath));
  const normalized = posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entryPath));
  if (normalized !== raw) throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entryPath));
  return normalized;
}

export function assertSourceArchiveEntryCount(count: number): void {
  if (count > SOURCE_ARCHIVE_MAX_FILES) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_TOO_MANY_FILES", `Archive contains too many entries (max ${SOURCE_ARCHIVE_MAX_FILES})`);
}

function bumpState(state: InspectState, bytes: number, regular: boolean, policy: SourceArchivePolicy): void {
  state.entries += 1; state.bytes += Math.max(0, bytes); if (regular) state.regularFiles += 1;
  assertSourceArchiveEntryCount(state.entries);
  if (state.bytes > maxExtractedBytes(policy)) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_EXTRACTED_TOO_LARGE", "Archive extracted content exceeds the safety limit");
}

function resolveLinkTarget(path: string, target: string): string | SourceArchiveWarningReason {
  if (!target || target.length > MAX_LINK_BYTES || target.includes("\\") || target.includes("\0") || target.startsWith("/") || target.startsWith("//") || /^[A-Za-z]:/.test(target)) {
    if (!target) return "dangling";
    if (target.length > MAX_LINK_BYTES) return "target_too_long";
    if (target.includes("\\") || target.includes("\0")) return "escapes_root";
    return "absolute_target";
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) return "escapes_root";
  return resolved;
}

/** Drop-mode variant: never throws for a bad link — mark dropped + warn (HALL-19). */
function dropLink(entry: ManifestEntry, reason: SourceArchiveWarningReason, warnings: SourceArchiveWarning[]): void {
  entry.dropped = true;
  warnings.push({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path: entry.path, link_target: entry.linkTarget ?? "", reason });
}

function validateManifest(entries: ManifestEntry[], policy: SourceArchivePolicy): ArchiveManifest {
  const warnings: SourceArchiveWarning[] = [];
  const drop = policy.symlink_policy !== "reject";
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
      // Drop mode: a dropped symlink ancestor is treated as absent — files
      // below it materialize through real (implicit) directories instead.
      const blocks = ancestor && ancestor.kind !== "directory" && !(ancestor.kind === "symlink" && ancestor.dropped && drop);
      if (blocks) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive entry has a non-directory parent: ${entry.path}`);
      parent = posix.dirname(parent);
    }
    if (entry.kind !== "symlink" || entry.dropped) continue;
    const resolved = resolveLinkTarget(entry.path, entry.linkTarget ?? "");
    // NOTE: a drop reason is also a plain string, so discriminate by the
    // known reason set — typeof alone cannot tell reason from path.
    if (isDropReason(resolved)) {
      if (drop) dropLink(entry, resolved, warnings);
      else throw archiveError("ERR_SOURCE_ARCHIVE_UNSAFE_PATH", zhUnsafePath(entry.path));
    } else entry.resolvedTarget = resolved;
  }
  for (const entry of entries.filter((item) => item.kind === "symlink")) {
    if (entry.dropped) continue;
    let target = entry.resolvedTarget!;
    const seen = new Set<string>([entry.path]);
    for (let depth = 0; depth <= MAX_LINK_DEPTH; depth += 1) {
      if (implicitDirs.has(target) && !byPath.has(target)) break;
      const targetEntry = byPath.get(target);
      if (!targetEntry) {
        if (drop) { dropLink(entry, "dangling", warnings); break; }
        throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains a dangling symbolic link: ${entry.path}`);
      }
      if (targetEntry.kind !== "symlink") break;
      if (seen.has(target)) {
        if (drop) { dropLink(entry, "cycle", warnings); break; }
        throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains a symbolic link cycle: ${entry.path}`);
      }
      seen.add(target);
      if (depth === MAX_LINK_DEPTH) {
        if (drop) { dropLink(entry, "too_deep", warnings); break; }
        throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive symbolic link chain is too deep: ${entry.path}`);
      }
      if (targetEntry.dropped) { if (drop) dropLink(entry, "dangling", warnings); break; }
      target = targetEntry.resolvedTarget!;
    }
  }
  return { entries, byPath, warnings };
}

function zipEntryMode(entry: yauzl.Entry): number { return (entry.externalFileAttributes >>> 16) & 0o170000; }
/**
 * ZIP entry reader for symlink targets. `maxBytes` rejects oversized targets
 * (ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY); callers decide whether that error
 * is fatal (reject policy) or downgraded to a drop + warning (HALL-19).
 */
function readZipEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry, maxBytes = MAX_LINK_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => zipfile.openReadStream(entry, (err, stream) => {
    if (err || !stream) return reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read ZIP entry"));
    const chunks: Buffer[] = []; let bytes = 0;
    stream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= maxBytes) chunks.push(chunk); });
    stream.on("end", () => bytes > maxBytes ? reject(archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive symbolic link target is too long: ${entry.fileName}`)) : resolve(Buffer.concat(chunks)));
    stream.on("error", () => reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read ZIP entry")));
  }));
}

async function buildZipManifest(archivePath: string, policy: SourceArchivePolicy): Promise<ArchiveManifest> {
  const state: InspectState = { entries: 0, regularFiles: 0, bytes: 0 }; const entries: ManifestEntry[] = []; const pendingWarnings: SourceArchiveWarning[] = [];
  await new Promise<void>((resolve, reject) => yauzl.open(archivePath, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
    if (err || !zipfile) return reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
    let stopped = false; const stop = (error: unknown) => { if (!stopped) { stopped = true; zipfile.close(); reject(error); } };
    zipfile.on("entry", async (entry) => {
      try {
        const rawName = entry.fileName as string | Buffer;
        const nameStr = decodeZipEntryName(rawName);
        const namedDir = (Buffer.isBuffer(rawName) ? rawName[rawName.length - 1] === 0x2f : String(rawName).endsWith("/"))
          || false;
        const path = normalizeEntryPath(nameStr);
        const mode = zipEntryMode(entry);
        let kind: EntryKind;
        if (namedDir && (mode === 0 || mode === 0o040000)) kind = "directory";
        else if (!namedDir && (mode === 0 || mode === 0o100000)) kind = "file";
        else if (!namedDir && mode === 0o120000) kind = "symlink";
        else throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry: ${nameStr}`);
        if (kind === "directory") { bumpState(state, 0, false, policy); entries.push({ path, kind, size: 0 }); }
        else if (kind === "file") { bumpState(state, entry.uncompressedSize ?? 0, true, policy); entries.push({ path, kind, size: entry.uncompressedSize ?? 0 }); }
        else {
          bumpState(state, entry.uncompressedSize ?? 0, false, policy); let raw: Buffer;
          try { raw = await readZipEntry(zipfile, entry); } catch (error) {
            // Oversized target: drop + warn in drop mode (tar parity, review #1);
            // reject policy keeps the legacy fail-fast.
            if (error instanceof SourceArchiveError && error.code === "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY" && policy.symlink_policy !== "reject") {
              entries.push({ path, kind, size: entry.uncompressedSize ?? 0, linkTarget: "", dropped: true });
              pendingWarnings.push({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path, link_target: "", reason: "target_too_long" });
              if (!stopped) zipfile.readEntry();
              return;
            }
            throw error;
          }
          let target: string;
          try { target = decodeArchiveBytes(raw, "symlink target"); } catch {
            if (policy.symlink_policy !== "reject") {
              // Non-UTF-8/GBK link target: drop + warn, keep the archive flowing (HALL-19).
              entries.push({ path, kind, size: raw.length, linkTarget: "", dropped: true });
              pendingWarnings.push({ code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED", path, link_target: "", reason: "target_not_utf8" });
            } else throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive symbolic link target is not UTF-8/GBK: ${nameStr}`);
            if (!stopped) zipfile.readEntry();
            return;
          }
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
  const manifest = validateManifest(entries, policy);
  manifest.warnings.unshift(...pendingWarnings);
  return manifest;
}

async function buildTarManifest(archivePath: string, policy: SourceArchivePolicy): Promise<ArchiveManifest> {
  const state: InspectState = { entries: 0, regularFiles: 0, bytes: 0 }; const entries: ManifestEntry[] = []; let firstError: SourceArchiveError | null = null;
  try {
    await tar.t({ file: archivePath, onentry(entry: any) {
      if (!firstError) try {
        const rawPath = entry.path ?? ""; if (String(rawPath) === "." || String(rawPath) === "./") { entry.resume?.(); return; }
        const raw = decodeTarEntryPath(rawPath as string | Buffer); if (raw === "." || raw === "./" || raw === "") { entry.resume?.(); return; }
        const path = normalizeEntryPath(raw); const type = String(entry.type ?? ""); let kind: EntryKind;
        if (type === "Directory") kind = "directory";
        else if (["File", "OldFile", "ContiguousFile"].includes(type)) kind = "file";
        else if (type === "SymbolicLink") kind = "symlink";
        else throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", `Archive contains unsupported entry type ${type}: ${raw}`);
        if (kind === "directory") { bumpState(state, 0, false, policy); entries.push({ path, kind, size: 0 }); }
        else if (kind === "file") { bumpState(state, Number(entry.size ?? 0), true, policy); entries.push({ path, kind, size: Number(entry.size ?? 0) }); }
        else { const target = String(entry.linkpath ?? ""); bumpState(state, Buffer.byteLength(target), false, policy); entries.push({ path, kind, size: Buffer.byteLength(target), linkTarget: target }); }
      } catch (error) { firstError = error instanceof SourceArchiveError ? error : archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive"); }
      entry.resume?.();
    } });
  } catch (error) { if (firstError) throw firstError; throw error instanceof SourceArchiveError ? error : archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot read TAR archive"); }
  if (firstError) throw firstError;
  if (state.regularFiles === 0) throw archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Archive contains no regular files");
  return validateManifest(entries, policy);
}

async function buildManifest(archivePath: string, filename: string, policy: SourceArchivePolicy): Promise<{ format: SourceArchiveFormat; manifest: ArchiveManifest }> {
  const detected = detectSourceArchive(filename); if (!detected) throw new SourceArchiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT", "Unsupported source archive format");
  return { format: detected.format, manifest: detected.format === "zip" ? await buildZipManifest(archivePath, policy) : await buildTarManifest(archivePath, policy) };
}

export async function inspectSourceArchive(archivePath: string, filename: string, policy: SourceArchivePolicy): Promise<{ warnings: SourceArchiveWarning[] }> {
  const { manifest } = await buildManifest(archivePath, filename, policy);
  return { warnings: manifest.warnings };
}

async function extractZip(archivePath: string, destDir: string, manifest: ArchiveManifest): Promise<void> {
  await new Promise<void>((resolve, reject) => yauzl.open(archivePath, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
    if (err || !zipfile) return reject(archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot open ZIP archive"));
    const next = () => zipfile.readEntry();
    zipfile.on("entry", (entry) => {
      let path: string; try { path = normalizeEntryPath(decodeZipEntryName(entry.fileName as string | Buffer)); } catch (error) { zipfile.close(); reject(error); return; }
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
      const decoded = decodeTarEntryPath(path as string | Buffer);
      const normalized = normalizeEntryPath(decoded); const item = manifest.byPath.get(normalized); return item?.kind === "file" || item?.kind === "directory";
    } });
  } catch (error) { throw error instanceof SourceArchiveError ? error : archiveError("ERR_SOURCE_ARCHIVE_CORRUPT", "Cannot extract TAR archive"); }
  await createLinks(destDir, manifest);
}

async function createLinks(destDir: string, manifest: ArchiveManifest): Promise<void> {
  // Dropped links (HALL-19 drop mode) are never materialized.
  for (const item of manifest.entries.filter((entry) => entry.kind === "symlink" && !entry.dropped)) {
    const target = join(destDir, item.path); await mkdir(dirname(target), { recursive: true, mode: 0o755 }); await symlink(item.linkTarget!, target);
  }
}

export function prepareSourceArchiveDestination(destDir: string): void {
  mkdirSync(dirname(destDir), { recursive: true });
  rmSync(destDir, { recursive: true, force: true });
}

export async function extractSourceArchive(archivePath: string, filename: string, destDir: string, policy: SourceArchivePolicy): Promise<{ warnings: SourceArchiveWarning[] }> {
  const parent = dirname(destDir); await mkdir(parent, { recursive: true });
  if (existsSync(destDir)) throw archiveError("ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY", "Extraction destination already exists");
  const tempDir = await mkdtemp(join(parent, ".source-extract-"));
  try {
    const { format, manifest } = await buildManifest(archivePath, filename, policy);
    if (format === "zip") await extractZip(archivePath, tempDir, manifest); else await extractTar(archivePath, tempDir, manifest);
    await rename(tempDir, destDir);
    return { warnings: manifest.warnings };
  } catch (error) { rmSync(tempDir, { recursive: true, force: true }); throw error; }
}

export function archiveFormatFromFilename(filename: string): SourceArchiveFormat | null { return detectSourceArchive(filename)?.format ?? null; }
