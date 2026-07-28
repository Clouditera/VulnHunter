import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural contract tests — no live server required.
 * Ensures role split + forbidAdmin + admin mounts stay wired.
 */
describe("admin console backend wiring", () => {
  const serverSrc = readFileSync(resolve(__dirname, "../../src/server.ts"), "utf8");
  const mainSrc = readFileSync(resolve(__dirname, "../../src/main.ts"), "utf8");
  const authMw = readFileSync(resolve(__dirname, "../../src/middleware/auth.ts"), "utf8");
  const codes = readFileSync(resolve(__dirname, "../../../shared/src/errors/codes.ts"), "utf8");
  const compose = readFileSync(resolve(__dirname, "../../../../deploy/docker-compose.yml"), "utf8");
  const ent = readFileSync(resolve(__dirname, "../../../enterprise/src/index.ts"), "utf8");

  it("exports createApp(role) with business|admin", () => {
    expect(serverSrc).toMatch(/export type ServiceRole = "business" \| "admin"/);
    expect(serverSrc).toMatch(/export function createApp\(role: ServiceRole/);
    expect(serverSrc).toMatch(/role === "admin"/);
  });

  it("business role mounts forbidAdmin on 9 prefixes and not /api/admin", () => {
    for (const p of [
      "/api/tasks",
      "/api/git",
      "/api/dashboard",
      "/api/settings",
      "/api/chat",
      "/api/feedback",
      "/api/notifications",
      "/api/downloads",
      "/api/sandbox",
    ]) {
      expect(serverSrc).toContain(`"${p}"`);
    }
    expect(serverSrc).toMatch(/mountForbidAdmin/);
    // business must NOT mount /api/admin
    expect(serverSrc).toMatch(/\/api\/admin\/\* intentionally NOT mounted/);
  });

  it("admin role mounts adminAuth + adminSystem + mountAdminRoutes", () => {
    expect(serverSrc).toMatch(/adminAuthRouter/);
    expect(serverSrc).toMatch(/adminSystemRouter/);
    expect(serverSrc).toMatch(/mountAdminRoutes/);
    expect(serverSrc).not.toMatch(/pocSettingsRouter/);
  });

  it("main.ts branches SERVICE_ROLE and skips migrations/scheduler on admin", () => {
    expect(mainSrc).toMatch(/SERVICE_ROLE/);
    expect(mainSrc).toMatch(/role === "admin"/);
    expect(mainSrc).toMatch(/runMigrations/);
    expect(mainSrc).toMatch(/TaskScheduler/);
  });

  it("forbidAdmin + error codes present", () => {
    expect(authMw).toMatch(/export const forbidAdmin/);
    expect(authMw).toMatch(/ERR_ADMIN_BUSINESS_FORBIDDEN/);
    expect(codes).toMatch(/ERR_ADMIN_BUSINESS_FORBIDDEN/);
    expect(codes).toMatch(/ERR_CREDIT_CODE_ASSIGNED/);
  });

  it("compose has admin-api/admin-web, no docker.sock on admin-api, 127.0.0.1 default", () => {
    expect(compose).toMatch(/admin-api:/);
    expect(compose).toMatch(/admin-web:/);
    expect(compose).toMatch(/SERVICE_ROLE: "admin"/);
    expect(compose).toMatch(/ADMIN_LISTEN_ADDR:-127\.0\.0\.1/);
    expect(compose).toMatch(/NGINX_ROLE: "admin"/);
    // admin-api block should not mount docker.sock — check the admin-api section
    const adminApiBlock = compose.split("admin-api:")[1]?.split("admin-web:")[0] ?? "";
    expect(adminApiBlock).not.toMatch(/docker\.sock/);
  });

  it("enterprise mounts /api/admin/users only on admin role", () => {
    expect(ent).toMatch(/role === "admin"/);
    expect(ent).toMatch(/\/api\/admin\/users/);
    expect(ent).not.toMatch(/app\.route\("\/api\/users"/);
  });
});
