/**
 * Code viewer: extracts individual files from uploaded source archives in MinIO.
 */

import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LRUCache } from "./lru-cache.js";
import { fileTypeFromBuffer } from "file-type";
import { listArchiveEntries, readArchiveFile, type ArchiveEntry } from "../source-archives/reader.js";
import { decodeTextFileContent } from "../source-archives/charset.js";

const FILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB — larger files get truncated
export const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024; // 5MB — avoid huge base64 JSON responses
export const TRUNCATED_MARKER = "\n\n[File truncated — download to view full content]";
const fileCache = new LRUCache<string, { content: string; language: string; totalLines: number; truncated: boolean }>(100, FILE_CACHE_TTL_MS);

export interface CodeFileResult {
  content: string;
  language: string;
  total_lines: number;
  size_bytes: number;
  is_truncated: boolean;
  type: "text" | "binary" | "image";
  mime?: string;
  data_base64?: string;
  vuln_decorations?: {
    line: number;
    finding_key: string;
    severity: string;
    message: string;
  }[];
}

function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    py: "python", js: "javascript", ts: "typescript", tsx: "typescript",
    java: "java", go: "go", rs: "rust", rb: "ruby", php: "php",
    sh: "shell", bash: "shell", yaml: "yaml", yml: "yaml", json: "json",
    md: "markdown", xml: "xml", html: "html", css: "css", sql: "sql",
    s: "asm", asm: "asm",
  };
  return langMap[ext] ?? "plaintext";
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.slice(0, 8192);
  if (sample.length === 0) return false;
  const nullCount = sample.filter((b) => b === 0).length;
  return nullCount / sample.length > 0.01;
}

function isPreviewableImage(mime?: string): boolean {
  // Do not inline SVG from untrusted repositories: SVG can contain active
  // content. It remains visible through the normal text/source path.
  return !!mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
}

// file-type recognises some TEXT-based formats (notably SVG and XML, which it
// reports as image/svg+xml or application/xml). Those must NOT fall into the
// binary branch — the user should read their source. They are shown through
// the plain-text path (escaped, never inline-rendered) so there is no XSS risk.
const TEXT_LIKE_DETECTED_MIMES = new Set([
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/html",
]);

function isTextLikeDetected(mime?: string): boolean {
  return !!mime && TEXT_LIKE_DETECTED_MIMES.has(mime);
}

async function downloadArchiveToTmp(bucket: string, key: string): Promise<string> {
  const minio = getMinio();
  const stream = await minio.getObject(bucket, key);
  const tmpPath = join(tmpdir(), `va-source-archive-${randomUUID()}`);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  await writeFile(tmpPath, Buffer.concat(chunks));
  return tmpPath;
}

async function safeFileTypeFromBuffer(buf: Buffer) {
  try {
    return await fileTypeFromBuffer(buf);
  } catch {
    return undefined;
  }
}

export async function classifyCodeFileBuffer(buf: Buffer, filePath: string, opts?: { truncatedMarker?: string }): Promise<CodeFileResult> {
  const detected = await safeFileTypeFromBuffer(buf);
  if (isPreviewableImage(detected?.mime)) {
    if (buf.length > MAX_IMAGE_PREVIEW_BYTES) {
      return {
        content: "",
        language: "binary",
        total_lines: 0,
        size_bytes: buf.length,
        is_truncated: false,
        type: "binary",
        mime: detected?.mime,
      };
    }
    return {
      content: "",
      language: "image",
      total_lines: 0,
      size_bytes: buf.length,
      is_truncated: false,
      type: "image",
      mime: detected?.mime,
      data_base64: buf.toString("base64"),
    };
  }

  if (!isTextLikeDetected(detected?.mime) && (detected || isBinary(buf))) {
    return {
      content: "",
      language: "binary",
      total_lines: 0,
      size_bytes: buf.length,
      is_truncated: false,
      type: "binary",
      mime: detected?.mime,
    };
  }

  const full = decodeTextFileContent(buf);
  const truncated = buf.length > MAX_FILE_SIZE_BYTES;
  const content = truncated
    ? decodeTextFileContent(buf.subarray(0, MAX_FILE_SIZE_BYTES)) + (opts?.truncatedMarker ?? TRUNCATED_MARKER)
    : full;
  return {
    content,
    language: detectLanguage(filePath),
    total_lines: full.split("\n").length,
    size_bytes: buf.length,
    is_truncated: truncated,
    type: "text",
  };
}

export async function getCodeFile(
  taskId: string,
  bucket: string,
  filePath: string,
  overrideZipKey?: string,
  archiveFilename = "source.zip",
): Promise<CodeFileResult | null> {
  const cacheKey = `${taskId}:${filePath}`;
  const cached = fileCache.get(cacheKey);

  if (cached) {
    return {
      content: cached.content,
      language: cached.language,
      total_lines: cached.totalLines,
      size_bytes: Buffer.byteLength(cached.content),
      is_truncated: cached.truncated,
      type: "text",
    };
  }

  const zipKey = overrideZipKey ?? `code-packages/${taskId}.zip`;
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadArchiveToTmp(bucket, zipKey);
    const buf = await readArchiveFile(tmpPath, archiveFilename, filePath);

    const result = await classifyCodeFileBuffer(buf, filePath);
    if (result.type === "text") {
      fileCache.set(cacheKey, {
        content: result.content,
        language: result.language,
        totalLines: result.total_lines,
        truncated: result.is_truncated,
      });
    }
    return result;
  } catch (err) {
    logger.warn({ err, taskId, filePath }, "Failed to extract file from source archive");
    return null;
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}

/** Read a single object from MinIO into a Buffer (null = missing). */
async function readMinioObject(bucket: string, key: string): Promise<Buffer | null> {
  const minio = getMinio();
  try {
    const stream = await minio.getObject(bucket, key);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch {
    return null; // Not Found and every other read error → caller falls through
  }
}

/** List all keys under a prefix (recursive). */
async function listMinioPrefix(bucket: string, prefix: string): Promise<string[]> {
  const minio = getMinio();
  return await new Promise<string[]>((resolve, reject) => {
    const keys: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) keys.push(obj.name); });
    stream.on("end", () => resolve(keys));
    stream.on("error", reject);
  });
}

export interface CodeFileOptions {
  /** MinIO key of a raw file (source-files tree) — bypasses the archive path. */
  minioKey?: string;
}

/**
 * getCodeFileFromMinioKey: read a plain MinIO object through the standard
 * text pipeline (charset decode / language detect / truncation / binary
 * classification). Used by the source-files viewer path.
 */
export async function getCodeFileFromMinioKey(
  taskId: string,
  bucket: string,
  key: string,
  filePath: string,
): Promise<CodeFileResult | null> {
  const cacheKey = `sf:${taskId}:${filePath}`;
  const cached = fileCache.get(cacheKey);
  if (cached) {
    return {
      content: cached.content,
      language: cached.language,
      total_lines: cached.totalLines,
      size_bytes: Buffer.byteLength(cached.content),
      is_truncated: cached.truncated,
      type: "text",
    };
  }
  const buf = await readMinioObject(bucket, key);
  if (!buf) return null;
  const result = await classifyCodeFileBuffer(buf, filePath);
  if (result.type === "text") {
    fileCache.set(cacheKey, {
      content: result.content,
      language: result.language,
      totalLines: result.total_lines,
      truncated: result.is_truncated,
    });
  }
  return result;
}

/** Top-level dirs under `source-files/<tid>/.vulnhunter-decompiled/`
 * (jarName list for the finding-path fallback). Cached briefly. */
let decompiledRootsCache: { at: number; roots: string[] } | null = null;
const DECOMPILED_ROOTS_TTL_MS = 60_000;

export async function listDecompiledRoots(bucket: string, taskId: string): Promise<string[]> {
  if (decompiledRootsCache && Date.now() - decompiledRootsCache.at < DECOMPILED_ROOTS_TTL_MS) {
    return decompiledRootsCache.roots;
  }
  const keys = await listMinioPrefix(bucket, `source-files/${taskId}/.vulnhunter-decompiled/`).catch(() => [] as string[]);
  const roots = [...new Set(
    keys
      .map((k) => k.slice(`source-files/${taskId}/.vulnhunter-decompiled/`.length))
      .map((rel) => rel.split("/")[0])
      .filter(Boolean),
  )];
  decompiledRootsCache = { at: Date.now(), roots };
  return roots;
}

/** Resolve a viewer path against the source-files tree.
 * Returns the exact MinIO key, or null when absent. */
export async function resolveSourceFilesKey(
  bucket: string,
  taskId: string,
  filePath: string,
): Promise<string | null> {
  const base = `source-files/${taskId}/`;
  // a) direct
  const direct = base + filePath.replace(/^\/+/, "");
  const buf = await readMinioObject(bucket, direct).then((b) => b !== null).catch(() => false);
  if (buf) return direct;
  // b) finding paths are relative to the decompiled root — try each jarName
  const roots = await listDecompiledRoots(bucket, taskId);
  for (const root of roots) {
    const key = `${base}.vulnhunter-decompiled/${root}/${filePath.replace(/^\/+/, "")}`;
    const hit = await readMinioObject(bucket, key).then((b) => b !== null).catch(() => false);
    if (hit) return key;
  }
  return null;
}

/** Tree from the source-files prefix (flat keys → nested tree). Empty array
 * when the prefix has no objects → caller falls back to the legacy blob. */
export async function getSourceFilesTree(
  taskId: string,
  bucket: string,
): Promise<{ name: string; type: "file" | "dir"; children?: unknown[] }[]> {
  const prefix = `source-files/${taskId}/`;
  const keys = await listMinioPrefix(bucket, prefix).catch(() => [] as string[]);
  if (keys.length === 0) return [];
  const entries: ArchiveEntry[] = keys.map((k) => ({
    path: k.slice(prefix.length),
    isDir: false,
  }));
  return buildTree(entries);
}

export async function getCodeTree(
  taskId: string,
  bucket: string,
  overrideZipKey?: string,
  archiveFilename = "source.zip",
): Promise<{ name: string; type: "file" | "dir"; hasVuln?: boolean; children?: unknown[] }[]> {
  // source-files first-class tree (task-c069aab9) — the viewer's authority.
  const tree = await getSourceFilesTree(taskId, bucket);
  if (tree.length > 0) return tree;

  // Legacy: on-the-fly blob unpack (old tasks without a source-files tree).
  const zipKey = overrideZipKey ?? `code-packages/${taskId}.zip`;
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadArchiveToTmp(bucket, zipKey);
    const entries = await listArchiveEntries(tmpPath, archiveFilename);

    // Build tree from flat list
    return buildTree(entries);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to list source archive entries");
    return [];
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}

type TreeNode = { name: string; type: "file" | "dir"; children?: TreeNode[] };

interface BuildNode {
  name: string;
  type: "file" | "dir";
  children: Record<string, BuildNode>;
}

function buildTree(entries: ArchiveEntry[]): TreeNode[] {
  const dirPaths = new Set<string>();
  for (const e of entries) {
    if (e.isDir) dirPaths.add(e.path);
  }

  const root: Record<string, BuildNode> = {};

  for (const entry of entries) {
    if (!entry.path) continue;
    const parts = entry.path.split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = !isLast || entry.isDir || dirPaths.has(entry.path);

      if (!current[part]) {
        current[part] = { name: part, type: isDir ? "dir" : "file", children: {} };
      } else if (isDir && current[part].type === "file") {
        current[part].type = "dir";
      }

      if (!isLast) {
        current = current[part].children;
      }
    }
  }

  function toArray(obj: Record<string, BuildNode>): TreeNode[] {
    return Object.values(obj)
      .sort((a, b) => {
        // Dirs first, then alphabetical
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => {
        const kids = Object.keys(n.children).length > 0 ? toArray(n.children) : undefined;
        return {
          name: n.name,
          type: n.type,
          ...(n.type === "dir" ? { children: kids ?? [] } : {}),
        };
      });
  }

  return toArray(root);
}
