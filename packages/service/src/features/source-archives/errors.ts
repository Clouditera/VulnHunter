export type SourceArchiveErrorCode =
  | "ERR_SOURCE_ARCHIVE_TOO_LARGE"
  | "ERR_TASK_UPLOAD_TOO_LARGE"
  | "ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT"
  | "ERR_SOURCE_ARCHIVE_CORRUPT"
  | "ERR_SOURCE_ARCHIVE_UNSAFE_PATH"
  | "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY"
  | "ERR_SOURCE_ARCHIVE_TOO_MANY_FILES"
  | "ERR_SOURCE_ARCHIVE_EXTRACTED_TOO_LARGE";

/** Why a symlink was dropped under symlink_policy=drop (HALL-19). */
export type SourceArchiveWarningReason =
  | "absolute_target"
  | "escapes_root"
  | "dangling"
  | "cycle"
  | "too_deep"
  | "target_too_long"
  | "target_not_utf8";

/**
 * Structured, non-fatal warning emitted when a problematic symlink is dropped
 * (symlink_policy=drop). The scan continues; consumers surface these to the
 * user / task metadata so audits know what is missing from the tree.
 */
export interface SourceArchiveWarning {
  code: "WARN_SOURCE_ARCHIVE_SYMLINK_DROPPED";
  path: string;
  link_target: string;
  reason: SourceArchiveWarningReason;
}

export class SourceArchiveError extends Error {
  constructor(
    public code: SourceArchiveErrorCode,
    message: string,
    public status = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sourceArchiveErrorResponse(err: SourceArchiveError) {
  return {
    error: {
      code: err.code,
      message: err.message,
      detail: err.message,
      ...err.extra,
    },
  };
}
