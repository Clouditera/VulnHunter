/**
 * Unified error registry — single source of truth for error code → user-layer
 * i18n key + guiding action + retriable flag. Shared between service and web.
 *
 * Spec: architecture/unified-error-handling-module-v1.0.md §2-3.
 * New codes MUST be added here — the `ErrorCode` union is derived from this
 * record, so unregistered codes are a compile-time error.
 */

/** Declarative action rendered as a small button in the user layer. */
export type ErrorAction =
  | { kind: "navigate"; to: string }
  | { kind: "retry" }
  | { kind: "none" };

export interface ErrorRegistryEntry {
  /** i18n key for the user-layer message (errors.<CODE>). */
  i18nKey: string;
  /** HTTP status the error-handler maps this code to. */
  httpStatus: number;
  /** Optional guiding action rendered as a small button. */
  action?: ErrorAction;
  /** Whether the operation can sensibly be retried. */
  retriable?: boolean;
}

// ── Seed codes (from real incidents, spec §3) ──────────────────────────

export const ERROR_REGISTRY = {
  // Prepare / worker pipeline
  ERR_PREPARE_FAILED: {
    i18nKey: "errors.ERR_PREPARE_FAILED",
    httpStatus: 502,
    retriable: true,
  },
  ERR_MODEL_UPSTREAM: {
    i18nKey: "errors.ERR_MODEL_UPSTREAM",
    httpStatus: 502,
    action: { kind: "navigate", to: "/settings?tab=credentials" },
  },
  ERR_WORKER_SPAWN_FAILED: {
    i18nKey: "errors.ERR_WORKER_SPAWN_FAILED",
    httpStatus: 500,
  },

  // Credentials
  ERR_CREDENTIAL_CORE_FIELD_REQUIRES_TEST: {
    i18nKey: "errors.ERR_CREDENTIAL_CORE_FIELD_REQUIRES_TEST",
    httpStatus: 400,
  },
  ERR_CREDENTIAL_TEST_FAILED: {
    i18nKey: "errors.ERR_CREDENTIAL_TEST_FAILED",
    httpStatus: 422,
  },
  ERR_LLM_API_KEY_INVALID: {
    i18nKey: "errors.ERR_LLM_API_KEY_INVALID",
    httpStatus: 502,
    action: { kind: "navigate", to: "/settings?tab=credentials" },
  },
  ERR_LLM_TIMEOUT: {
    i18nKey: "errors.ERR_LLM_TIMEOUT",
    httpStatus: 504,
    retriable: true,
  },

  // Sandbox
  ERR_SANDBOX_NOT_CONFIGURED: {
    i18nKey: "errors.ERR_SANDBOX_NOT_CONFIGURED",
    httpStatus: 409,
    action: { kind: "navigate", to: "/settings" },
  },

  // Auth
  ERR_AUTH_REQUIRED: {
    i18nKey: "errors.ERR_AUTH_REQUIRED",
    httpStatus: 401,
  },
  ERR_AUTH_INVALID_CREDENTIALS: {
    i18nKey: "errors.ERR_AUTH_INVALID_CREDENTIALS",
    httpStatus: 401,
  },
  ERR_AUTH_LOCKED: {
    i18nKey: "errors.ERR_AUTH_LOCKED",
    httpStatus: 429,
    retriable: true,
  },
  ERR_ADMIN_REQUIRED: {
    i18nKey: "errors.ERR_ADMIN_REQUIRED",
    httpStatus: 403,
  },
  ERR_ADMIN_USE_CONSOLE: {
    i18nKey: "errors.ERR_ADMIN_USE_CONSOLE",
    httpStatus: 403,
  },
  ERR_ADMIN_BUSINESS_FORBIDDEN: {
    i18nKey: "errors.ERR_ADMIN_BUSINESS_FORBIDDEN",
    httpStatus: 403,
  },

  // License
  ERR_LICENSE_NOT_ACTIVATED: {
    i18nKey: "errors.ERR_LICENSE_NOT_ACTIVATED",
    httpStatus: 402,
    action: { kind: "navigate", to: "/activate" },
  },
  ERR_LICENSE_EXPIRED: {
    i18nKey: "errors.ERR_LICENSE_EXPIRED",
    httpStatus: 402,
    action: { kind: "navigate", to: "/activate" },
  },
  ERR_LICENSE_INVALID: {
    i18nKey: "errors.ERR_LICENSE_INVALID",
    httpStatus: 402,
    action: { kind: "navigate", to: "/activate" },
  },

  // Tasks
  ERR_TASK_NOT_FOUND: {
    i18nKey: "errors.ERR_TASK_NOT_FOUND",
    httpStatus: 404,
  },
  ERR_TASK_UPLOAD_TOO_LARGE: {
    i18nKey: "errors.ERR_TASK_UPLOAD_TOO_LARGE",
    httpStatus: 413,
  },
  ERR_TASK_NAME_CONFLICT: {
    i18nKey: "errors.ERR_TASK_NAME_CONFLICT",
    httpStatus: 409,
  },
  ERR_GIT_CLONE_FAILED: {
    i18nKey: "errors.ERR_GIT_CLONE_FAILED",
    httpStatus: 400,
  },
  ERR_TASK_LIMIT_EXCEEDED: {
    i18nKey: "errors.ERR_TASK_LIMIT_EXCEEDED",
    httpStatus: 403,
  },
  ERR_TASK_BUSY: {
    i18nKey: "errors.ERR_TASK_BUSY",
    httpStatus: 409,
    retriable: true,
  },

  // Source archives
  ERR_SOURCE_ARCHIVE_UNSAFE_PATH: {
    i18nKey: "errors.ERR_SOURCE_ARCHIVE_UNSAFE_PATH",
    httpStatus: 400,
  },
  ERR_SOURCE_ARCHIVE_TOO_LARGE: {
    i18nKey: "errors.ERR_SOURCE_ARCHIVE_TOO_LARGE",
    httpStatus: 413,
  },
  ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT: {
    i18nKey: "errors.ERR_SOURCE_ARCHIVE_UNSUPPORTED_FORMAT",
    httpStatus: 400,
  },
  ERR_SOURCE_ARCHIVE_CORRUPT: {
    i18nKey: "errors.ERR_SOURCE_ARCHIVE_CORRUPT",
    httpStatus: 400,
  },

  // API tokens
  ERR_API_TOKEN_LIMIT: {
    i18nKey: "errors.ERR_API_TOKEN_LIMIT",
    httpStatus: 403,
  },
  ERR_API_TOKEN_NOT_FOUND: {
    i18nKey: "errors.ERR_API_TOKEN_NOT_FOUND",
    httpStatus: 404,
  },
  ERR_API_TOKEN_NAME_REQUIRED: {
    i18nKey: "errors.ERR_API_TOKEN_NAME_REQUIRED",
    httpStatus: 400,
  },
  ERR_API_TOKEN_REVOKED: {
    i18nKey: "errors.ERR_API_TOKEN_REVOKED",
    httpStatus: 400,
  },

  // Admin / accounts
  ERR_PROTECTED_ACCOUNT: {
    i18nKey: "errors.ERR_PROTECTED_ACCOUNT",
    httpStatus: 400,
  },
  ERR_ADMIN_SINGLETON: {
    i18nKey: "errors.ERR_ADMIN_SINGLETON",
    httpStatus: 400,
  },
  ERR_CREDIT_CODE_ASSIGNED: {
    i18nKey: "errors.ERR_CREDIT_CODE_ASSIGNED",
    httpStatus: 409,
  },
  ERR_PROMO_DISABLED: {
    i18nKey: "errors.ERR_PROMO_DISABLED",
    httpStatus: 403,
  },

  // Generic
  ERR_INTERNAL: {
    i18nKey: "errors.ERR_INTERNAL",
    httpStatus: 500,
  },
  ERR_NOT_FOUND: {
    i18nKey: "errors.ERR_NOT_FOUND",
    httpStatus: 404,
  },
  ERR_VALIDATION: {
    i18nKey: "errors.ERR_VALIDATION",
    httpStatus: 400,
  },
  // E3 wave — credential/settings specific codes
  ERR_CREDENTIAL_KEY_UNAVAILABLE: {
    i18nKey: "errors.ERR_CREDENTIAL_KEY_UNAVAILABLE",
    httpStatus: 409,
  },
  ERR_CREDENTIAL_DECRYPT_FAILED: {
    i18nKey: "errors.ERR_CREDENTIAL_DECRYPT_FAILED",
    httpStatus: 409,
  },
  ERR_UPLOAD_TOO_LARGE: {
    i18nKey: "errors.ERR_UPLOAD_TOO_LARGE",
    httpStatus: 413,
  },
  // E4 wave — codes used in sandbox/auth/tasks that need registry entries
  ERR_INVALID_STATE: {
    i18nKey: "errors.ERR_INVALID_STATE",
    httpStatus: 409,
  },
  ERR_INVALID_SCAN_OPTIONS: {
    i18nKey: "errors.ERR_INVALID_SCAN_OPTIONS",
    httpStatus: 400,
  },
  ERR_INVALID_GIT_URL: {
    i18nKey: "errors.ERR_INVALID_GIT_URL",
    httpStatus: 400,
  },
  ERR_GIT_REMOTE_UNREACHABLE: {
    i18nKey: "errors.ERR_GIT_REMOTE_UNREACHABLE",
    httpStatus: 503,
    action: { kind: "navigate", to: "/settings?tab=credentials" },
  },
  ERR_MODEL_CREDENTIAL_UNAVAILABLE: {
    i18nKey: "errors.ERR_MODEL_CREDENTIAL_UNAVAILABLE",
    httpStatus: 503,
    action: { kind: "navigate", to: "/settings?tab=credentials" },
  },
  ERR_NO_LLM_CREDENTIAL: {
    i18nKey: "errors.ERR_NO_LLM_CREDENTIAL",
    httpStatus: 400,
    action: { kind: "navigate", to: "/settings?tab=credentials" },
  },
  ERR_SELF_SUSPEND: {
    i18nKey: "errors.ERR_SELF_SUSPEND",
    httpStatus: 400,
  },
  ERR_SELF_DELETE: {
    i18nKey: "errors.ERR_SELF_DELETE",
    httpStatus: 400,
  },
  ERR_LAST_ADMIN: {
    i18nKey: "errors.ERR_LAST_ADMIN",
    httpStatus: 400,
  },
  ERR_SOURCE_ARCHIVE_NOT_AVAILABLE: {
    i18nKey: "errors.ERR_SOURCE_ARCHIVE_NOT_AVAILABLE",
    httpStatus: 404,
  },
  ERR_SOURCE_ARCHIVE_NOT_FOUND: {
    i18nKey: "errors.ERR_SOURCE_ARCHIVE_NOT_FOUND",
    httpStatus: 404,
  },
} as const satisfies Record<string, ErrorRegistryEntry>;

/** Registered error codes — adding a code elsewhere is a tsc error. */
export type ErrorCode = keyof typeof ERROR_REGISTRY;

/** Look up an entry; returns ERR_INTERNAL entry for unknown codes. */
export function getErrorEntry(code: string): ErrorRegistryEntry {
  return (ERROR_REGISTRY as Record<string, ErrorRegistryEntry>)[code] ?? ERROR_REGISTRY.ERR_INTERNAL;
}

/** HTTP status for a code (safe for unknown → 500). */
export function errorHttpStatus(code: string): number {
  return getErrorEntry(code).httpStatus;
}
