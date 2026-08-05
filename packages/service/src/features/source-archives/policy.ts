import { getSystemConfig } from "../settings/storage.js";
import { SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS } from "./detect.js";
import { deploymentUploadCeilingMb, normalizeSourceArchiveUploadMaxMb } from "./limits.js";

export const SOURCE_ARCHIVE_MAX_FILES = 200_000;

export interface SourceArchivePolicy {
  max_mb: number;
  max_bytes: number;
  gateway_max_mb?: number;
  effective_max_mb?: number;
  source_archive_upload_ceiling_mb: number;
  formats: Array<"zip" | "tar" | "tar.gz">;
  extensions: string[];
  accept: string;
}

export const SOURCE_ARCHIVE_ACCEPT = [
  ".zip",
  ".tar",
  // macOS file pickers match the final suffix of compound extensions, so .gz
  // is needed to make .tar.gz selectable. Application validation still uses
  // SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS and rejects standalone .gz files.
  ".gz",
  ".tgz",
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
].join(",");

export function normalizeUploadMaxMb(config: Record<string, unknown>): number {
  return normalizeSourceArchiveUploadMaxMb(config);
}

export function gatewayLimitMbFromEnv(): number {
  return deploymentUploadCeilingMb();
}

export function buildSourceArchivePolicy(config: Record<string, unknown>): SourceArchivePolicy {
  const gatewayMaxMb = deploymentUploadCeilingMb();
  const maxMb = normalizeSourceArchiveUploadMaxMb(config, gatewayMaxMb);
  return {
    max_mb: maxMb,
    max_bytes: maxMb * 1024 * 1024,
    gateway_max_mb: gatewayMaxMb,
    effective_max_mb: maxMb,
    source_archive_upload_ceiling_mb: gatewayMaxMb,
    formats: ["zip", "tar", "tar.gz"],
    extensions: [...SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS],
    accept: SOURCE_ARCHIVE_ACCEPT,
  };
}

export async function getSourceArchivePolicy(): Promise<SourceArchivePolicy> {
  return buildSourceArchivePolicy(await getSystemConfig());
}

export function maxExtractedBytes(policy: SourceArchivePolicy): number {
  const derivedMb = Math.min(Math.max(policy.max_mb * 5, 1024), 8192);
  return derivedMb * 1024 * 1024;
}
