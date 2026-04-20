import type { MiddlewareHandler } from "hono";
import { getCurrentState } from "../features/license/service.js";

/** Block business APIs when license is not active */
export const licenseGuard: MiddlewareHandler = async (c, next) => {
  const state = await getCurrentState();
  if (state.status === "active") {
    await next();
    return;
  }
  const code =
    state.status === "expired" ? "ERR_LICENSE_EXPIRED" : "ERR_LICENSE_NOT_ACTIVATED";
  return c.json({ error: { code } }, 402);
};
