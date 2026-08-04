/**
 * ApiError — unified client-side error type for the platform's structured
 * error contract `{ error: { code, traceId?, details? } }`.
 *
 * Part of the unified error handling module (spec:
 * architecture/unified-error-handling-module-v1.0.md). The user-facing
 * message is NEVER taken from the server; it is resolved locally from the
 * error registry (seed table below → shared registry once E1-core lands).
 */

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
 * Seed registry — mirrors architect spec §3. Shape matches the upcoming
 * `@vulnhunter/shared` errors registry 1:1 so the swap is a one-line change
 * (E1-core dependency). Keys use `errors.<code>` i18n namespace.
 */
const ERROR_SPECS: Record<string, ErrorSpec> = {
  ERR_PREPARE_FAILED: { i18nKey: "errors.ERR_PREPARE_FAILED", retriable: true },
  ERR_MODEL_UPSTREAM: {
    i18nKey: "errors.ERR_MODEL_UPSTREAM",
    action: { kind: "navigate", to: "/settings?tab=credentials" },
  },
  ERR_CREDENTIAL_TEST_FAILED: { i18nKey: "errors.ERR_CREDENTIAL_TEST_FAILED" },
  ERR_SANDBOX_NOT_CONFIGURED: {
    i18nKey: "errors.ERR_SANDBOX_NOT_CONFIGURED",
    action: { kind: "navigate", to: "/settings" },
  },
  ERR_AUTH_LOCKED: { i18nKey: "errors.ERR_AUTH_LOCKED", retriable: true },
  ERR_TASK_NAME_CONFLICT: { i18nKey: "errors.ERR_TASK_NAME_CONFLICT" },
  ERR_PROTECTED_ACCOUNT: { i18nKey: "errors.ERR_PROTECTED_ACCOUNT" },
  ERR_SOURCE_ARCHIVE_UNSAFE_PATH: { i18nKey: "errors.ERR_SOURCE_ARCHIVE_UNSAFE_PATH" },
  ERR_LICENSE_INVALID: {
    i18nKey: "errors.ERR_LICENSE_INVALID",
    action: { kind: "navigate", to: "/activate" },
  },
  ERR_LICENSE_EXPIRED: {
    i18nKey: "errors.ERR_LICENSE_EXPIRED",
    action: { kind: "navigate", to: "/activate" },
  },
  ERR_INTERNAL: { i18nKey: "errors.ERR_INTERNAL" },
};

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

/** Registry lookup with fallback (unregistered codes must never surface raw). */
export function resolveErrorSpec(code: string): ErrorSpec {
  return ERROR_SPECS[code] ?? { i18nKey: "errors.fallback" };
}

/** `{placeholder}` interpolation from details. */
function interpolate(template: string, details?: Record<string, unknown>): string {
  if (!details) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) =>
    details[k] !== undefined && details[k] !== null ? String(details[k]) : m,
  );
}
