/**
 * AppError — the only error class business code should throw.
 * Unified error handling module (spec §2).
 *
 * The error-handler serializes to `{ error: { code, traceId, details? } }`.
 * User-layer message is NOT sent by the server (frontend renders via registry).
 */

import type { ErrorCode } from "@vulnhunter/shared";

export class AppError extends Error {
  /** Registered error code. */
  readonly code: ErrorCode;
  /** JSON-safe diagnostics (endpoint/status/phase/numbers); never secrets. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    options?: {
      details?: Record<string, unknown>;
      cause?: Error;
      message?: string;
    },
  ) {
    super(options?.message ?? code, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.details = options?.details;
  }
}
