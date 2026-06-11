/**
 * Code viewer: extracts individual files from code-packages/<taskId>.zip in MinIO.
 * Uses yauzl for random-access zip extraction (no full unzip needed).
 */

import yauzl from "yauzl";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LRUCache } from "./lru-cache.js";
import { fileTypeFromBuffer } from "file-type";

const FILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB — larger files get truncated
const MAX_IMAGE_PREVIEW_BYTES = 5 * 1024 * 1024; // 5MB — avoid huge base64 JSON responses
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

async function downloadZipToTmp(bucket: string, key: string): Promise<string> {
  const minio = getMinio();
  const stream = await minio.getObject(bucket, key);
  const tmpPath = join(tmpdir(), `va-zip-${randomUUID()}.zip`);

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  await writeFile(tmpPath, Buffer.concat(chunks));
  return tmpPath;
}

async function extractFileFromZip(zipPath: string, targetPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Cannot open zip"));

      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const entryPath = entry.fileName.replace(/^\//, "");
        if (entryPath === targetPath || entryPath.endsWith("/" + targetPath)) {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) {
              zipfile.close();
              return reject(err2 ?? new Error("Cannot open stream"));
            }
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => {
              zipfile.close();
              resolve(Buffer.concat(chunks));
            });
            stream.on("error", (e) => { zipfile.close(); reject(e); });
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => reject(new Error(`File not found in zip: ${targetPath}`)));
      zipfile.on("error", reject);
    });
  });
}

async function safeFileTypeFromBuffer(buf: Buffer) {
  try {
    return await fileTypeFromBuffer(buf);
  } catch {
    return undefined;
  }
}

export async function classifyCodeFileBuffer(buf: Buffer, filePath: string): Promise<CodeFileResult> {
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

  if (detected || isBinary(buf)) {
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

  const full = buf.toString("utf-8");
  const truncated = buf.length > MAX_FILE_SIZE_BYTES;
  const content = truncated
    ? buf.slice(0, MAX_FILE_SIZE_BYTES).toString("utf-8") + "\n\n[File truncated — download to view full content]"
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
    tmpPath = await downloadZipToTmp(bucket, zipKey);
    const buf = await extractFileFromZip(tmpPath, filePath);

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
    logger.warn({ err, taskId, filePath }, "Failed to extract file from zip");
    return null;
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}

export async function getCodeTree(
  taskId: string,
  bucket: string,
  overrideZipKey?: string,
): Promise<{ name: string; type: "file" | "dir"; hasVuln?: boolean; children?: unknown[] }[]> {
  const zipKey = overrideZipKey ?? `code-packages/${taskId}.zip`;
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadZipToTmp(bucket, zipKey);
    const entries = await listZipEntries(tmpPath);

    // Build tree from flat list
    return buildTree(entries);
  } catch (err) {
    logger.warn({ err, taskId }, "Failed to list zip entries");
    return [];
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}

interface ZipEntry {
  path: string;
  isDir: boolean;
}

async function listZipEntries(zipPath: string): Promise<ZipEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ZipEntry[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Cannot open zip"));

      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        const isDir = entry.fileName.endsWith("/");
        entries.push({ path: entry.fileName.replace(/\/$/, ""), isDir });
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
    });
  });
}

type TreeNode = { name: string; type: "file" | "dir"; children?: TreeNode[] };

interface BuildNode {
  name: string;
  type: "file" | "dir";
  children: Record<string, BuildNode>;
}

function buildTree(entries: ZipEntry[]): TreeNode[] {
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
