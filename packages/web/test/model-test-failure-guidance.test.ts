import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const progress = readFileSync(
  resolve(__dirname, "../src/features/settings/components/CredentialTestProgress.tsx"),
  "utf8",
);
const zh = readFileSync(resolve(__dirname, "../src/shared/i18n/zh.ts"), "utf8");

describe("model connection failure guidance", () => {
  it("shows an explicit failure conclusion, reason, and solution", () => {
    expect(progress).toContain('data-testid="test-failure-guidance"');
    expect(progress).toContain('i18n.t("settings.model.testFail")');
    expect(progress).toContain('i18n.t("settings.model.testFailureReason")');
    expect(progress).toContain('i18n.t("settings.model.testFailureSolution")');
    expect(zh).toContain('"settings.model.testFailureReason": "失败原因"');
    expect(zh).toContain('"settings.model.testFailureSolution": "解决措施"');
  });

  it("maps common upstream failures to actionable fixes", () => {
    expect(progress).toMatch(/status === 401 \|\| status === 403/);
    expect(progress).toMatch(/status === 404/);
    expect(progress).toMatch(/status === 429/);
    expect(progress).toMatch(/enotfound\|econnrefused\|timeout/);
  });
});
