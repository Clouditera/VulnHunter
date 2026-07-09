export const SOURCE_ARCHIVE_UPLOAD_DEFAULT_MB = 500;
export const SOURCE_ARCHIVE_UPLOAD_MIN_MB = 1;
export const SOURCE_ARCHIVE_UPLOAD_DEFAULT_CEILING_MB = 2048;

export function deploymentUploadCeilingMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.UPLOAD_GATEWAY_LIMIT_MB ?? env.VULNAGENT_UPLOAD_GATEWAY_LIMIT_MB;
  if (!raw) return SOURCE_ARCHIVE_UPLOAD_DEFAULT_CEILING_MB;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < SOURCE_ARCHIVE_UPLOAD_MIN_MB) return SOURCE_ARCHIVE_UPLOAD_DEFAULT_CEILING_MB;
  return Math.trunc(n);
}

export function normalizeSourceArchiveUploadMaxMb(
  config: Record<string, unknown>,
  ceilingMb = deploymentUploadCeilingMb(),
): number {
  const ceiling = Math.max(SOURCE_ARCHIVE_UPLOAD_MIN_MB, Math.trunc(ceilingMb));
  const fallback = Math.min(SOURCE_ARCHIVE_UPLOAD_DEFAULT_MB, ceiling);
  const raw = config.source_archive_upload_max_mb ?? config.upload_zip_max_mb ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(ceiling, Math.max(SOURCE_ARCHIVE_UPLOAD_MIN_MB, Math.trunc(n)));
}
