declare module "@vulnagent/enterprise" {
  import type { Hono } from "hono";
  import type { ServiceConfig } from "./infra/config.js";

  export function initEnterprise(
    app: Hono,
    config: ServiceConfig,
  ): Promise<{ tickLicense: () => Promise<void> }>;
}
