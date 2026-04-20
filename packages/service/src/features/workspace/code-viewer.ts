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

const FILE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB — larger files get truncated
const fileCache = new LRUCache<string, { content: string; language: string; totalLines: number; truncated: boolean }>(100, FILE_CACHE_TTL_MS);

export interface CodeFileResult {
  content: string;
  language: string;
  total_lines: number;
  size_bytes: number;
  is_truncated: boolean;
  type: "text" | "binary" | "image";
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
  const nullCount = sample.filter((b) => b === 0).length;
  return nullCount / sample.length > 0.01;
}

async function downloadZipToTmp(bucket: string, key: string): Promise<string> {
  const minio = getMinio();
  const stream = await minio.getObject(bucket, key);
  const tmpPath = join(tmpdir(), `vh-zip-${randomUUID()}.zip`);

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

export async function getCodeFile(
  taskId: string,
  bucket: string,
  filePath: string,
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

  const zipKey = `code-packages/${taskId}.zip`;
  let tmpPath: string | null = null;

  try {
    tmpPath = await downloadZipToTmp(bucket, zipKey);
    const buf = await extractFileFromZip(tmpPath, filePath);

    if (isBinary(buf)) {
      return {
        content: "",
        language: "binary",
        total_lines: 0,
        size_bytes: buf.length,
        is_truncated: false,
        type: "binary",
      };
    }

    const full = buf.toString("utf-8");
    const truncated = buf.length > MAX_FILE_SIZE_BYTES;
    const content = truncated
      ? buf.slice(0, MAX_FILE_SIZE_BYTES).toString("utf-8") + "\n\n[File truncated — download to view full content]"
      : full;
    const language = detectLanguage(filePath);
    const totalLines = full.split("\n").length;

    fileCache.set(cacheKey, { content, language, totalLines, truncated });

    return {
      content,
      language,
      total_lines: totalLines,
      size_bytes: buf.length,
      is_truncated: truncated,
      type: "text",
    };
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
): Promise<{ name: string; type: "file" | "dir"; hasVuln?: boolean; children?: unknown[] }[]> {
  const zipKey = `code-packages/${taskId}.zip`;
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

async function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Cannot open zip"));

      zipfile.readEntry();
      zipfile.on("entry", (entry: yauzl.Entry) => {
        names.push(entry.fileName.replace(/\/$/, ""));
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(names));
      zipfile.on("error", reject);
    });
  });
}

type TreeNode = { name: string; type: "file" | "dir"; children?: TreeNode[] };

function buildTree(paths: string[]): TreeNode[] {
  const root: Record<string, TreeNode> = {};

  for (const p of paths) {
    if (!p) continue;
    const parts = p.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const isLast = i === parts.length - 1;

      if (!current[part]) {
        current[part] = isLast
          ? { name: part, type: "file" }
          : { name: part, type: "dir", children: [] };
      }

      if (!isLast) {
        const children = current[part].children ?? [];
        current[part].children = children;
        // Convert children array to object for building
        const childMap: Record<string, TreeNode> = {};
        for (const c of children) childMap[c.name] = c;
        current = childMap;
      }
    }
  }

  function toArray(obj: Record<string, TreeNode>): TreeNode[] {
    return Object.values(obj).map((n) => ({
      ...n,
      children: n.children
        ? toArray(
            Object.fromEntries((n.children as TreeNode[]).map((c) => [c.name, c])),
          )
        : undefined,
    }));
  }

  return toArray(root);
}
