import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serverSrc = readFileSync(
  resolve(import.meta.dirname, "../../src/server.ts"),
  "utf8",
);

describe("promo server wiring", () => {
  it("mounts promoRouter and forbids admin on /api/promo", () => {
    expect(serverSrc).toMatch(/promoRouter/);
    expect(serverSrc).toMatch(/app\.route\("\/api\/promo",\s*promoRouter\)/);
    expect(serverSrc).toMatch(/"\/api\/promo"/);
    // listed in ADMIN_FORBIDDEN_PREFIXES block
    const forbiddenBlock = serverSrc.slice(
      serverSrc.indexOf("ADMIN_FORBIDDEN_PREFIXES"),
      serverSrc.indexOf("] as const"),
    );
    expect(forbiddenBlock).toContain('"/api/promo"');
  });
});
