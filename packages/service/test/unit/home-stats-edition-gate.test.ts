import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { systemRouter } from "../../src/features/system/routes.js";

// GET /api/system/home-stats 仅 SaaS 开放（营销统计，私有化部署纵深防御）。
function app() {
  const a = new Hono();
  a.route("/api/system", systemRouter);
  return a;
}

const ORIGINAL = process.env.EDITION;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.EDITION;
  else process.env.EDITION = ORIGINAL;
});

describe("home-stats edition gate", () => {
  it("enterprise → 404", async () => {
    process.env.EDITION = "enterprise";
    const res = await app().request("/api/system/home-stats");
    expect(res.status).toBe(404);
  });

  it("community → 404", async () => {
    process.env.EDITION = "community";
    const res = await app().request("/api/system/home-stats");
    expect(res.status).toBe(404);
  });

  it("saas → 门控放行（无 DB 环境下允许下游 500，但不得是 404）", async () => {
    process.env.EDITION = "saas";
    const res = await app().request("/api/system/home-stats");
    expect(res.status).not.toBe(404);
  });
});
