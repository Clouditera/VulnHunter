import { getSystemConfig } from "../settings/storage.js";
import { SUPPORTED_SOURCE_ARCHIVE_EXTENSIONS } from "./detect.js";
import { deploymentUploadCeilingMb, normalizeSourceArchiveUploadMaxMb } from "./limits.js";

export const SOURCE_ARCHIVE_MAX_FILES = 200_000;

/** How problematic symlinks are handled (HALL-19). */
export type SourceArchiveSymlinkPolicy = "drop" | "reject";

function normalizeSymlinkPolicy(raw: unknown): SourceArchiveSymlinkPolicy {
  return raw === "reject" ? "reject" : "drop";
}

export interface SourceArchivePolicy {
  max_mb: number;
  max_bytes: number;
  gateway_max_mb?: number;
  effective_max_mb?: number;
  source_archive_upload_ceiling_mb: number;
  /** drop = filter bad symlinks + warn (default, HALL-19); reject = fail fast (legacy). */
  symlink_policy: SourceArchiveSymlinkPolicy;
  formats: Array<"zip" | "tar" | "tar.gz" | "jar" | "war">;
  extensions: string[];
  accept: string;
}

export const SOURCE_ARCHIVE_ACCEPT = [
  ".zip",
  ".jar",
  ".war",
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
  "application/java-archive",
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
    symlink_policy: normalizeSymlinkPolicy(config.source_archive_symlink_policy),
    formats: ["zip", "jar", "war", "tar", "tar.gz"],
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
