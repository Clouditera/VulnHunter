/**
 * ApiError — unified client-side error type for the platform's structured
 * error contract `{ error: { code, traceId?, details? } }`.
 *
 * Part of the unified error handling module (spec:
 * architecture/unified-error-handling-module-v1.0.md). The user-facing
 * message is NEVER taken from the server; it is resolved locally from the
 * error registry (seed table below → shared registry once E1-core lands).
 */

import { ERROR_REGISTRY } from "@vulnhunter/shared";
import { i18n } from "../i18n/index.js";

/** Declarative action reference attached to an error code. */
export type ErrorAction =
  | { kind: "navigate"; to: string }
  | { kind: "retry" }
  | { kind: "none" };

export interface ErrorSpec {
  /** i18n key for the user-layer message. */
  i18nKey: string;
  /** Optional guiding action rendered as a small button. */
  action?: ErrorAction;
  /** Whether the operation can sensibly be retried. */
  retriable?: boolean;
}

/**
 * Registry lookup: shared `ERROR_REGISTRY` (E1-core) is the single source of
 * truth; unregistered codes fall back to generic copy so raw codes never
 * render as the primary message.
 */
export function resolveErrorSpec(code: string): ErrorSpec {
  const entry = (ERROR_REGISTRY as Record<string, ErrorRegistryEntryLike | undefined>)[code];
  return entry ?? { i18nKey: "errors.fallback" };
}

type ErrorRegistryEntryLike = { i18nKey: string; action?: ErrorAction; retriable?: boolean };

export interface StructuredErrorBody {
  error: { code: string; traceId?: string; details?: Record<string, unknown> };
}

/** Type guard for the platform's structured error body. */
export function isStructuredErrorBody(v: unknown): v is StructuredErrorBody {
  if (typeof v !== "object" || v === null) return false;
  const e = (v as Record<string, unknown>).error;
  if (typeof e !== "object" || e === null) return false;
  return typeof (e as Record<string, unknown>).code === "string";
}

export class ApiError extends Error {
  /** Registry code, e.g. ERR_TASK_NAME_CONFLICT. ERR_UNKNOWN when absent. */
  readonly code: string;
  readonly httpStatus?: number;
  readonly traceId?: string;
  /** JSON-safe diagnostics (endpoint/status/phase/…); never secrets. */
  readonly details?: Record<string, unknown>;

  constructor(init: {
    code: string;
    message?: string;
    httpStatus?: number;
    traceId?: string;
    details?: Record<string, unknown>;
  }) {
    super(init.message ?? init.code);
    this.name = "ApiError";
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.traceId = init.traceId;
    this.details = init.details;
  }

  /** Build from an HTTP failure response body (already parsed JSON when possible). */
  static fromHttp(status: number, body: unknown): ApiError {
    if (isStructuredErrorBody(body)) {
      return new ApiError({
        code: body.error.code,
        httpStatus: status,
        traceId: body.error.traceId,
        details: body.error.details,
      });
    }
    // Legacy / unstructured bodies: keep the raw text as diagnostic detail,
    // never as the user-facing message.
    const raw =
      typeof body === "string" ? body : body ? JSON.stringify(body) : "";
    return new ApiError({
      code: "ERR_UNKNOWN",
      httpStatus: status,
      details: raw ? { raw: raw.slice(0, 500) } : undefined,
    });
  }

  /** Normalize any thrown value into an ApiError. */
  static from(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    if (err instanceof Error) {
      return new ApiError({
        code: "ERR_UNKNOWN",
        message: err.message,
        details: { raw: err.message.slice(0, 500) },
      });
    }
    return new ApiError({ code: "ERR_UNKNOWN", message: String(err) });
  }

  /** Registry spec for this error's code (fallback spec when unregistered). */
  get spec(): ErrorSpec {
    return resolveErrorSpec(this.code);
  }

  /** User-layer message via i18n registry; never a raw code/key. */
  get userMessage(): string {
    const key = this.spec.i18nKey;
    const translated = i18n.t(key);
    if (translated && translated !== key) {
      return interpolate(translated, this.details);
    }
    // Unregistered code or missing translation → generic fallback.
    return i18n.t("errors.fallback");
  }
}


/** `{placeholder}` interpolation from details. */
function interpolate(template: string, details?: Record<string, unknown>): string {
  if (!details) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) =>
    details[k] !== undefined && details[k] !== null ? String(details[k]) : m,
  );
}
