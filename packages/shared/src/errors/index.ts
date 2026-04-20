export { ERROR_CATALOG, type ErrorCode } from "./codes.js";

export interface ApiError {
  error: {
    code: string;
    summary: string;
    trace_id?: string;
    context?: Record<string, unknown>;
  };
}
