import type { DbTask } from "./storage.js";
import { contentTypeForSourceArchive, sourceMetaObject } from "../source-archives/detect.js";

export interface OriginalArchiveDownloadSpec {
  filename: string;
  safeFilename: string;
  minioKey: string;
  contentType: string;
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
  return contentTypeForSourceArchive(filename);
}

export function originalArchiveDownloadSpec(
  task: Pick<DbTask, "id" | "project_name" | "source_type" | "source_meta">,
): OriginalArchiveDownloadSpec | null {
  if (task.source_type !== "upload") return null;

  const meta = sourceMetaObject(task.source_meta);
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
