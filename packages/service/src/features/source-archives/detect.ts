import { basename } from "node:path";

export type SourceArchiveFormat = "zip" | "tar" | "tar.gz";

export interface DetectedSourceArchive {
  format: SourceArchiveFormat;
  extension: ".zip" | ".tar" | ".tar.gz" | ".tgz";
  storageExtension: ".zip" | ".tar" | ".tar.gz";
}

export const SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"] as const;

export function detectSourceArchive(filename: string): DetectedSourceArchive | null {
  const lower = basename(filename).toLowerCase();
  if (lower.endsWith(".tar.gz")) return { format: "tar.gz", extension: ".tar.gz", storageExtension: ".tar.gz" };
  if (lower.endsWith(".tgz")) return { format: "tar.gz", extension: ".tgz", storageExtension: ".tar.gz" };
  if (lower.endsWith(".tar")) return { format: "tar", extension: ".tar", storageExtension: ".tar" };
  if (lower.endsWith(".zip")) return { format: "zip", extension: ".zip", storageExtension: ".zip" };
  return null;
}

export function stripSourceArchiveExtension(filename: string): string {
  const base = basename(filename).trim();
  return base.replace(/\.(tar\.gz|tgz|tar|zip)$/i, "") || base || "source";
}

export function contentTypeForSourceArchive(filename: string): string {
  const detected = detectSourceArchive(filename);
  if (detected?.format === "zip") return "application/zip";
  if (detected?.format === "tar") return "application/x-tar";
  if (detected?.format === "tar.gz") return "application/gzip";
  return "application/octet-stream";
}

export function sourceMetaObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function resolveArchiveIdentity(params: { taskId: string; sourceMeta: unknown }) {
  const meta = sourceMetaObject(params.sourceMeta);
  const minioKey = typeof meta.minio_key === "string" && meta.minio_key.trim()
    ? meta.minio_key.trim()
    : `code-packages/${params.taskId}.zip`;
  const filename = typeof meta.filename === "string" && meta.filename.trim()
    ? meta.filename.trim()
    : basename(minioKey) || "source.zip";
  const archiveFormat = typeof meta.archive_format === "string" && meta.archive_format.trim()
    ? meta.archive_format.trim()
    : detectSourceArchive(filename)?.format ?? detectSourceArchive(minioKey)?.format ?? "zip";
  return { meta, minioKey, filename, archiveFormat };
}
