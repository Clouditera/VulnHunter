import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("home public stats contract", () => {
  const src = readFileSync(
    resolve(__dirname, "../../src/features/home/stats.ts"),
    "utf8",
  );

  it("exposes only aggregate non-sensitive fields", () => {
    expect(src).toMatch(/findings_total/);
    expect(src).toMatch(/findings_high/);
    expect(src).toMatch(/tasks_completed/);
    expect(src).not.toMatch(/avg_duration/);
    expect(src).not.toMatch(/language_count/);
    expect(src).not.toMatch(/user_email/);
    expect(src).toMatch(/no PII/i);
  });
});
