declare module "@vulnhunter/saas" {
  import type { Hono } from "hono";
  export type ServiceRole = "business" | "admin";
  export function initSaas(
    app: Hono,
    config: { edition: string; dataDir: string },
    role?: ServiceRole,
  ): Promise<void>;
}
