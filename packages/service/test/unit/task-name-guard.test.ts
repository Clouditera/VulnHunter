import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Server-side task-name enforcement (task-8cb27359, DRUDGE-154 follow-up):
 * the shared rule must be wired into create (upload+git) and rename paths,
 * and the rule itself must live in packages/shared (single source).
 */
const guard = await import("../../src/features/tasks/task-name-guard.js");
const { assertValidTaskName } = guard;

function expectValidation(name: string | undefined | null, opts?: { required?: boolean }) {
  try {
    assertValidTaskName(name, opts);
    return null;
  } catch (err: any) {
    return err?.errorCode ?? err?.code ?? err?.message;
  }
}

describe("assertValidTaskName (service guard)", () => {
  it("accepts a valid Chinese/ASCII name", () => {
    expect(expectValidation("扫描任务A_1(测试)")).toBeNull();
    expect(expectValidation("TripStar-2026_08")).toBeNull();
  });

  it("rejects >64 code points (surrogate-safe)", () => {
    const long = "任".repeat(65);
    expect(expectValidation(long)).toBeTruthy();
  });

  it("rejects illegal characters (e.g. spaces inside are allowed? no — spaces are NOT in whitelist)", () => {
    // Whitelist: Han / A-Za-z0-9 / _ - ( ) （）
    expect(expectValidation("任务/路径")).toBeTruthy(); // slash
    expect(expectValidation("任务 带空格")).toBeTruthy(); // space
    expect(expectValidation("a<b")).toBeTruthy(); // angle brackets
  });

  it("rejects empty/whitespace-only name", () => {
    expect(expectValidation("")).toBeTruthy();
    expect(expectValidation("   ")).toBeTruthy();
  });

  it("create path: absent name is optional (null/undefined pass)", () => {
    expect(expectValidation(undefined)).toBeNull();
    expect(expectValidation(null)).toBeNull();
  });

  it("rename path: absent name is rejected (required)", () => {
    expect(expectValidation(undefined, { required: true })).toBeTruthy();
    expect(expectValidation(null, { required: true })).toBeTruthy();
    expect(expectValidation("", { required: true })).toBeTruthy();
  });
});

describe("task-name rule lives in shared (single source)", () => {
  it("web module re-exports from @vulnhunter/shared", () => {
    const webMod = readFileSync(
      resolve(__dirname, "../../../web/src/features/tasks/task-name.ts"),
      "utf8",
    );
    expect(webMod).toMatch(/from "@vulnhunter\/shared"/);
    expect(webMod).not.toContain("TASK_NAME_PATTERN");
  });

  it("shared owns the pattern + limits", () => {
    const sharedMod = readFileSync(
      resolve(__dirname, "../../../shared/src/domain/task-name.ts"),
      "utf8",
    );
    expect(sharedMod).toMatch(/TASK_NAME_MAX_LENGTH = 64/);
    expect(sharedMod).toMatch(/p\{Script=Han\}/);
    expect(sharedMod).toContain("export function getTaskNameError");
  });
});

describe("enforcement points wired (structural)", () => {
  it("PATCH display-name calls assertValidTaskName with required", () => {
    const routes = readFileSync(
      resolve(__dirname, "../../src/features/tasks/routes.ts"),
      "utf8",
    );
    expect(routes).toMatch(/assertValidTaskName\(body\.display_name, \{ required: true \}\)/);
  });

  it("create endpoints (upload + git) call assertValidTaskName", () => {
    const files = readFileSync(
      resolve(__dirname, "../../src/features/files/routes.ts"),
      "utf8",
    );
    expect(files.match(/assertValidTaskName\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
