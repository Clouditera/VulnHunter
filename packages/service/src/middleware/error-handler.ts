import type { ErrorHandler } from "hono";
import { ERROR_CATALOG, type ErrorCode } from "@vulnhunter/shared";
import { logger } from "../infra/logger.js";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly context?: Record<string, unknown>,
    cause?: Error,
  ) {
    super(code, { cause });
  }
}

export const errorHandler: ErrorHandler = (err, c) => {
  const traceId = c.get("traceId" as never) as string | undefined;

  if (err instanceof AppError) {
    const catalog = ERROR_CATALOG[err.code];
    const lang = c.req.header("accept-language")?.startsWith("zh") ? "zh" : "en";
    const summary = catalog.summary[lang];
    return c.json(
      { error: { code: err.code, summary, trace_id: traceId, context: err.context } },
      catalog.httpStatus as never,
    );
  }

  logger.error({ err, traceId }, "Unhandled error");
  return c.json(
    { error: { code: "ERR_INTERNAL", summary: "Internal server error", trace_id: traceId } },
    500,
  );
};
