import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

// First-install setup wizard (fish 2026-08-06 终稿, 单路径版): admin-api-only
// endpoints reachable BEFORE license + admin exist; triple-closed; rate-limited.
const hasAnyAdmin = vi.fn();
const createUser = vi.fn();
const getLicenseStatus = vi.fn();

vi.mock("../../src/features/auth/storage.js", () => ({
  hasAnyAdmin: (...args: unknown[]) => hasAnyAdmin(...args),
  createUser: (...args: unknown[]) => createUser(...args),
}));
vi.mock("../../src/features/system/license-status.js", () => ({
  getLicenseStatus: (...args: unknown[]) => getLicenseStatus(...args),
}));

const { adminSetupRouter } = await import("../../src/features/admin/setup-routes.js");

function makeApp() {
  const app = new Hono();
  app.route("/api/admin/setup", adminSetupRouter);
  return app;
}

const ACTIVE = { status: "active", issued_at: null, expires_at: null, raw: "x" } as const;
const INACTIVE = { status: "not_activated", issued_at: null, expires_at: null, raw: null } as const;

function post(app: Hono, ip: string, body: unknown) {
  return app.request("/api/admin/setup/admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("admin setup wizard (triple closure + rate limit)", () => {
  beforeEach(() => {
    hasAnyAdmin.mockReset();
    createUser.mockReset();
    getLicenseStatus.mockReset();
    hasAnyAdmin.mockResolvedValue(false);
    getLicenseStatus.mockResolvedValue(ACTIVE as never);
    delete process.env.VULNHUNTER_ADMIN_EMAIL;
    delete process.env.VULNHUNTER_ADMIN_PASSWORD;
  });

  it("GET /setup/status exposes has_admin + license_active + env_admin_configured", async () => {
    const app = makeApp();
    hasAnyAdmin.mockResolvedValue(false);
    getLicenseStatus.mockResolvedValue(INACTIVE as never);
    const res = await app.request("/api/admin/setup/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.has_admin).toBe(false);
    expect(body.license_active).toBe(false);
    expect(body.env_admin_configured).toBe(false);
  });

  it("POST /setup/admin succeeds on a fresh install and creates the singleton admin", async () => {
    const app = makeApp();
    const res = await post(app, "10.0.0.1", { email: "admin@corp.local", password: "Passw0rd!" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(createUser).toHaveBeenCalledTimes(1);
    const arg = createUser.mock.calls[0][0];
    expect(arg.email).toBe("admin@corp.local");
    expect(arg.role).toBe("admin");
    expect(arg.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt hash
  });

  it("closure 1: has_admin=true → 403 (wizard no longer exists)", async () => {
    const app = makeApp();
    hasAnyAdmin.mockResolvedValue(true);
    const res = await post(app, "10.0.0.2", { email: "admin@corp.local", password: "Passw0rd!" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ERR_ADMIN_SINGLETON");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("closure 2: env-provisioned admin configured → 403", async () => {
    const app = makeApp();
    process.env.VULNHUNTER_ADMIN_EMAIL = "deploy@corp.local";
    process.env.VULNHUNTER_ADMIN_PASSWORD = "DeployPass1";
    const res = await post(app, "10.0.0.3", { email: "admin@corp.local", password: "Passw0rd!" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ERR_ADMIN_SINGLETON");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("closure 3: license not active → 402 (wizard order: activate first)", async () => {
    const app = makeApp();
    getLicenseStatus.mockResolvedValue(INACTIVE as never);
    const res = await post(app, "10.0.0.4", { email: "admin@corp.local", password: "Passw0rd!" });
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("ERR_LICENSE_NOT_ACTIVATED");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("weak password → 400 ERR_VALIDATION, no create", async () => {
    const app = makeApp();
    const res = await post(app, "10.0.0.5", { email: "admin@corp.local", password: "short" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ERR_VALIDATION");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("rate limit: >10 attempts per IP → 429, other IP unaffected", async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      const r = await post(app, "10.0.0.9", { email: "a@b.local", password: "Passw0rd!" });
      expect(r.status).toBe(200);
    }
    const eleventh = await post(app, "10.0.0.9", { email: "a@b.local", password: "Passw0rd!" });
    expect(eleventh.status).toBe(429);
    // a different IP is not throttled
    const other = await post(app, "10.0.0.10", { email: "a@b.local", password: "Passw0rd!" });
    expect(other.status).toBe(200);
  });
});

describe("admin setup wiring (structural)", () => {
  it("server mounts /api/admin/setup on the admin role only; business bootstrap removed", () => {
    const server = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../src/server.ts"),
      "utf8",
    );
    expect(server).toMatch(/adminSetupRouter/);
    expect(server).toMatch(/\/api\/admin\/setup/);
  });

  it("business /api/system/bootstrap endpoint is gone", () => {
    const routes = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../src/features/auth/routes.ts"),
      "utf8",
    );
    expect(routes).not.toMatch(/authRouter\.post\("\/bootstrap"/);
    expect(routes).not.toMatch(/\/\/ POST \/api\/system\/bootstrap\nauthRouter/);
  });

  it("status carries admin_console_port from ADMIN_PORT", () => {
    const sys = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../src/features/system/routes.ts"),
      "utf8",
    );
    expect(sys).toMatch(/admin_console_port/);
    expect(sys).toMatch(/ADMIN_PORT/);
  });

  it("compose default ADMIN_LISTEN_ADDR is 0.0.0.0 and .env.example documents it", () => {
    const compose = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../../deploy/docker-compose.yml"),
      "utf8",
    );
    const envExample = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../../deploy/.env.example"),
      "utf8",
    );
    expect(compose).toMatch(/ADMIN_LISTEN_ADDR:-0\.0\.0\.0/);
    expect(envExample).toMatch(/ADMIN_LISTEN_ADDR=0\.0\.0\.0/);
  });
});
