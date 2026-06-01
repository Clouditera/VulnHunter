import type { MiddlewareHandler } from "hono";

/**
 * Community edition: license is not required.
 * Enterprise edition overrides this guard via setLicenseGuard().
 */
let activeLicenseGuard: MiddlewareHandler = async (_c, next) => {
  await next();
};

export const licenseGuard: MiddlewareHandler = async (c, next) => {
  return activeLicenseGuard(c, next);
};

export function setLicenseGuard(guard: MiddlewareHandler): void {
  activeLicenseGuard = guard;
}
