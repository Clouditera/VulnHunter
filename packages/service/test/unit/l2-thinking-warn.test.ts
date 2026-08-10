import { describe, expect, it } from "vitest";
import type { DiagnosticCheck } from "../../src/features/settings/pi-diagnostics.js";

/**
 * fish 2026-08-10: L2 thinking "not observed" = warn (not hard fail).
 * ok = no fail AND (pass|na, or warn only on L2).
 */

function computeOk(checks: DiagnosticCheck[]): boolean {
  const hasFail = checks.some((c) => c.status === "fail");
  return !hasFail && checks.every((c) =>
    c.status === "pass" || c.status === "na" ||
    (c.id === "thinking" && c.status === "warn"),
  );
}

function mk(id: string, status: DiagnosticCheck["status"], layer: string): DiagnosticCheck {
  return { id: id as any, label: id, layer: layer as any, status, message: "" };
}

describe("L2 warn ok computation", () => {
  it("all pass → ok", () => {
    expect(computeOk([
      mk("basic", "pass", "L1"),
      mk("thinking", "pass", "L2"),
      mk("tool", "pass", "L3"),
      mk("l4_agent", "pass", "L4"),
    ])).toBe(true);
  });

  it("L2 warn + rest pass → ok (can save)", () => {
    expect(computeOk([
      mk("basic", "pass", "L1"),
      mk("thinking", "warn", "L2"),
      mk("tool", "pass", "L3"),
      mk("l4_agent", "pass", "L4"),
    ])).toBe(true);
  });

  it("L1 fail + L2 warn → not ok", () => {
    expect(computeOk([
      mk("basic", "fail", "L1"),
      mk("thinking", "warn", "L2"),
      mk("tool", "fail", "L3"),
      mk("l4_agent", "fail", "L4"),
    ])).toBe(false);
  });

  it("L3 fail → not ok", () => {
    expect(computeOk([
      mk("basic", "pass", "L1"),
      mk("thinking", "pass", "L2"),
      mk("tool", "fail", "L3"),
      mk("l4_agent", "fail", "L4"),
    ])).toBe(false);
  });

  it("L2 na (thinking off) + rest pass → ok (regression anchor)", () => {
    expect(computeOk([
      mk("basic", "pass", "L1"),
      mk("thinking", "na", "L2"),
      mk("tool", "pass", "L3"),
      mk("l4_agent", "pass", "L4"),
    ])).toBe(true);
  });

  it("non-L2 warn → not ok (warn only allowed on L2)", () => {
    expect(computeOk([
      mk("basic", "pass", "L1"),
      mk("thinking", "warn", "L2"),
      mk("tool", "warn", "L3"),
      mk("l4_agent", "pass", "L4"),
    ])).toBe(false);
  });
});
