import type { DbTask } from "./storage.js";

export interface OriginalArchiveDownloadSpec {
  filename: string;
  safeFilename: string;
  minioKey: string;
  contentType: string;
}

function sourceMetaObject(task: Pick<DbTask, "source_meta">): Record<string, unknown> {
  const raw = task.source_meta;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

export function safeDownloadFilename(filename: string): string {
  const trimmed = filename.trim();
  const sanitized = trimmed
    .replace(/[\\/\r\n\t\0]/g, "_")
    .replace(/"/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/^\.+$/, "archive.zip");
  return sanitized || "archive.zip";
}

export function contentTypeForArchive(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "application/gzip";
  if (lower.endsWith(".tar.bz2") || lower.endsWith(".tbz2")) return "application/x-bzip2";
  return "application/octet-stream";
}

export function originalArchiveDownloadSpec(
  task: Pick<DbTask, "id" | "project_name" | "source_type" | "source_meta">,
): OriginalArchiveDownloadSpec | null {
  if (task.source_type !== "upload") return null;

  const meta = sourceMetaObject(task);
  const filename = typeof meta.filename === "string" && meta.filename.trim()
    ? meta.filename.trim()
    : `${task.project_name || task.id}.zip`;
  const minioKey = typeof meta.minio_key === "string" && meta.minio_key.trim()
    ? meta.minio_key.trim()
    : `code-packages/${task.id}.zip`;

  return {
    filename,
    safeFilename: safeDownloadFilename(filename),
    minioKey,
    contentType: contentTypeForArchive(filename),
  };
}
