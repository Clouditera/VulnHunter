import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWebSource = (path: string) => readFileSync(resolve(__dirname, "../src", path), "utf8");

/**
 * task-ac572a8e C: idle sandbox auto-release hours card on the admin
 * SystemPage. Pins the surface contract:
 * - card renders behind hasDynamicVerification (community → no card);
 * - the hours input enforces 1..720 client-side;
 * - i18n keys exist in zh + en;
 * - config type carries sandbox_idle_release_hours.
 */
describe("admin sandbox idle-release card (task-ac572a8e C)", () => {
  const page = readWebSource("features/admin/pages/SystemPage.tsx");
  const adminI18n = readWebSource("shared/i18n/admin.ts");
  const apiClient = readWebSource("shared/api/client.ts");

  it("renders the card only when dynamic verification exists", () => {
    expect(page).toMatch(/hasDynamicVerification/);
    expect(page).toMatch(/\{hasDynamicVerification \? \(/);
    expect(page).toContain('data-testid="admin-card-sandbox-ttl"');
  });

  it("bounds the hours input 1..720 and validates before save", () => {
    expect(page).toMatch(/min=\{1\}/);
    expect(page).toMatch(/max=\{720\}/);
    expect(page).toMatch(/n < 1 \|\| n > 720/);
    expect(page).toContain('data-testid="admin-save-idle-hours"');
  });

  it("sends sandbox_idle_release_hours to the system config API", () => {
    expect(page).toMatch(/updateSystemConfig\(\{ sandbox_idle_release_hours: n \}\)/);
    expect(apiClient).toContain("sandbox_idle_release_hours?: number");
  });

  it("ships zh + en copy for the card", () => {
    for (const key of ["idleHoursTitle", "idleHoursDesc", "idleHoursUnit", "idleHoursHint", "idleHoursSaved", "idleHoursInvalid"]) {
      const re = new RegExp(`"admin\\.system\\.${key}"`, "g");
      expect(adminI18n.match(re)?.length).toBe(2); // once in zh block, once in en
    }
    expect(adminI18n).toContain("默认 168 小时（7 天），范围 1–720");
  });
});
