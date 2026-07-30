import { decodeTextFileContent } from "../source-archives/charset.js";
export const CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES = 64 * 1024;

export type ArtifactPreviewStatus = "ready" | "unsupported" | "failed";

export interface ArtifactPreviewResult {
  preview?: string;
  preview_status: ArtifactPreviewStatus;
  preview_truncated: boolean;
}

export function isPreviewableMime(mime?: string | null): boolean {
  if (!mime) return false;
  return mime.startsWith("text/")
    || mime.includes("markdown")
    || ["application/json", "application/xml", "application/javascript"].includes(mime);
}

export function buildBufferPreview(buffer: Buffer, mime: string): ArtifactPreviewResult {
  if (!isPreviewableMime(mime)) {
    return { preview_status: "unsupported", preview_truncated: false };
  }
  const previewBuffer = buffer.subarray(0, CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES);
  return {
    preview: decodeTextFileContent(Buffer.from(previewBuffer)),
    preview_status: "ready",
    preview_truncated: buffer.length > CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES,
  };
}

export async function readMinioPreview(minio: any, bucket: string, key: string, mime: string): Promise<ArtifactPreviewResult> {
  if (!isPreviewableMime(mime)) {
    return { preview_status: "unsupported", preview_truncated: false };
  }
  try {
    const stream = await minio.getObject(bucket, key);
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        if (total < CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES) {
          chunks.push(chunk.subarray(0, Math.max(0, CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES - total)));
        }
        total += chunk.length;
      });
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    return {
      preview: decodeTextFileContent(Buffer.concat(chunks)),
      preview_status: "ready",
      preview_truncated: total > CHAT_ARTIFACT_PREVIEW_LIMIT_BYTES,
    };
  } catch {
    return { preview_status: "failed", preview_truncated: false };
  }
}
