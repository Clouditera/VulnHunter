import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export const traceId: MiddlewareHandler = async (c, next) => {
  const id = randomUUID();
  c.set("traceId" as never, id);
  c.header("X-Trace-Id", id);
  await next();
};
