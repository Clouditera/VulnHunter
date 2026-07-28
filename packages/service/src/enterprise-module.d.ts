declare module "@vulnhunter/enterprise" {
  import type { Hono } from "hono";
  import type { ServiceConfig } from "./infra/config.js";

  export type ServiceRole = "business" | "admin";

  export function initEnterprise(
    app: Hono,
    config: ServiceConfig,
    role?: ServiceRole,
  ): Promise<{ tickLicense: () => Promise<void> }>;
}
