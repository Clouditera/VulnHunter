import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/infra/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { AppError } = await import("../../src/infra/app-error.js");
const { errorHandler } = await import("../../src/middleware/error-handler.js");

/** Minimal Hono context mock. */
function mockCtx(traceId?: string) {
  const headers: Record<string, string> = {};
  return {
    get: (key: string) => (key === "traceId" ? traceId : undefined),
    req: { header: (name: string) => headers[name] ?? undefined },
    json: (body: unknown, status?: number) => ({ body, status }),
  } as never;
}

describe("AppError", () => {
  it("carries code + details", () => {
    const err = new AppError("ERR_PREPARE_FAILED", {
      details: { exitCode: 1, phase: "prepare" },
    });
    expect(err.code).toBe("ERR_PREPARE_FAILED");
    expect(err.details).toEqual({ exitCode: 1, phase: "prepare" });
    expect(err.name).toBe("AppError");
  });

  it("works without details", () => {
    const err = new AppError("ERR_NOT_FOUND");
    expect(err.details).toBeUndefined();
  });
});

describe("errorHandler", () => {
  it("serializes AppError to { error: { code, traceId, details } }", () => {
    const err = new AppError("ERR_MODEL_UPSTREAM", {
      details: { status: 404, endpoint: "https://example.com/v1" },
    });
    const result = errorHandler(err, mockCtx("trace-123"));
    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      error: {
        code: "ERR_MODEL_UPSTREAM",
        traceId: "trace-123",
        details: { status: 404, endpoint: "https://example.com/v1" },
      },
    });
  });

  it("omits details when empty", () => {
    const err = new AppError("ERR_NOT_FOUND");
    const result = errorHandler(err, mockCtx("trace-456"));
    expect(result.body).toEqual({
      error: { code: "ERR_NOT_FOUND", traceId: "trace-456" },
    });
  });

  it("unknown error → ERR_INTERNAL + traceId + 500", () => {
    const result = errorHandler(new Error("boom"), mockCtx("trace-789"));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: { code: "ERR_INTERNAL", traceId: "trace-789" },
    });
  });

  it("does NOT send user-layer message (frontend renders via registry)", () => {
    const err = new AppError("ERR_AUTH_LOCKED");
    const result = errorHandler(err, mockCtx("t1"));
    const body = result.body as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty("summary");
    expect(body.error).not.toHaveProperty("message");
  });
});
