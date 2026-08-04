/**
 * Unified error handler — serializes AppError and unknown errors to the
 * platform's structured contract: `{ error: { code, traceId, details? } }`.
 *
 * Spec: architecture/unified-error-handling-module-v1.0.md §2.
 *
 * Key decisions (fish confirmed):
 * - User-layer message is NOT sent by the server (frontend renders via registry)
 * - Unknown exceptions → ERR_INTERNAL + traceId
 * - details only contains JSON-safe fields, never credentials/request bodies
 */

import type { ErrorHandler } from "hono";
import { errorHttpStatus, type ErrorCode } from "@vulnhunter/shared";
import { logger } from "../infra/logger.js";
import { AppError } from "../infra/app-error.js";

export { AppError } from "../infra/app-error.js";

export const errorHandler: ErrorHandler = (err, c) => {
  const traceId = (c.get("traceId" as never) as string | undefined) ?? undefined;

  if (err instanceof AppError) {
    const status = errorHttpStatus(err.code);
    // Log structured (buried for support; no secrets)
    logger.error(
      { code: err.code, traceId, details: err.details, errMsg: err.cause instanceof Error ? err.cause.message : undefined },
      "AppError",
    );
    return c.json(
      {
        error: {
          code: err.code,
          traceId,
          ...(err.details && Object.keys(err.details).length > 0
            ? { details: err.details }
            : {}),
        },
      },
      status as never,
    );
  }

  // Unknown exception → ERR_INTERNAL
  logger.error({ err, traceId }, "Unhandled error");
  return c.json(
    { error: { code: "ERR_INTERNAL" as ErrorCode, traceId } },
    500,
  );
};
