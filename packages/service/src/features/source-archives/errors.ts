export type SourceArchiveErrorCode =
  | "ERR_SOURCE_ARCHIVE_TOO_LARGE"
  | "ERR_TASK_UPLOAD_TOO_LARGE"
  | "ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT"
  | "ERR_SOURCE_ARCHIVE_CORRUPT"
  | "ERR_SOURCE_ARCHIVE_UNSAFE_PATH"
  | "ERR_SOURCE_ARCHIVE_UNSUPPORTED_ENTRY"
  | "ERR_SOURCE_ARCHIVE_TOO_MANY_FILES"
  | "ERR_SOURCE_ARCHIVE_EXTRACTED_TOO_LARGE";

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
