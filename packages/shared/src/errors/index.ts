// Unified error handling module — shared between service and web.
// Spec: architecture/unified-error-handling-module-v1.0.md

export { ERROR_REGISTRY, getErrorEntry, errorHttpStatus } from "./registry.js";
export { sanitizeErrorText, parseStructuredFailure } from "./failure.js";
export type { StructuredFailure } from "./failure.js";
export type {
  ErrorAction,
  ErrorRegistryEntry,
  ErrorCode,
} from "./registry.js";

// Legacy catalog kept for backward compat during migration waves.
// New code should use ERROR_REGISTRY instead.
export { ERROR_CATALOG, type LegacyErrorCode } from "./codes.js";
