import { sanitizeErrorText } from "@vulnhunter/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HALL-4: engine-reported failure reasons may embed Docker stdcopy frame
 * header bytes. failSchedulerClaim / updateTaskState are the only two writes
 * to tasks.failure_reason — both must sanitize before persisting.
 */

interface CapturedQuery {
  sql: string;
  values: unknown[];
}
const captured: CapturedQuery[] = [];

vi.mock("../../src/infra/db/client.js", () => ({
  getDb:
    () =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ sql: strings.join("?"), values });
      return [];
    },
}));

import { failSchedulerClaim, updateTaskState } from "../../src/features/tasks/storage.js";

const DIRTY_REASON = JSON.stringify({
  code: "ERR_PREPARE_FAILED",
  message:
    "Prepare 失败 (退出码 4): \u0002\u0000\u0000\u0000\u0000\u0000\u0000002:57:41 [youngflow.runner] ERROR [prepare] ✕ API error (1): 403: " +
    '{"code":"no_default_group","message":"no default group available for this model"}',
  details: { engineError: "exit code 4" },
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control chars are gone requires matching them
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\u200B-\u200D]/;

beforeEach(() => {
  captured.length = 0;
});

describe("failure_reason sanitizing (HALL-4)", () => {
  it("failSchedulerClaim persists a sanitized reason", async () => {
    await failSchedulerClaim("task-1", "token-1", DIRTY_REASON);
    const q = captured.find((c) => c.sql.includes("failure_reason"));
    expect(q).toBeDefined();
    const stored = q?.values.find((v) => typeof v === "string" && v.includes("ERR_PREPARE_FAILED"));
    expect(typeof stored).toBe("string");
    expect(stored as string).not.toMatch(CONTROL_CHAR_RE);
    expect(stored as string).toContain("Prepare 失败 (退出码 4)");
    expect(stored as string).toContain("no default group available for this model");
    // Storage contract unchanged: still the JSON string, just clean.
    expect(stored).toBe(sanitizeErrorText(DIRTY_REASON));
  });

  it("updateTaskState(failed) sanitizes extra.failureReason", async () => {
    await updateTaskState("task-2", "failed", {
      completedAt: new Date(),
      failureReason: DIRTY_REASON,
    });
    const q = captured.find((c) => c.sql.includes("failure_reason"));
    expect(q).toBeDefined();
    const stored = q?.values.find((v) => typeof v === "string" && v.includes("ERR_PREPARE_FAILED"));
    expect(typeof stored).toBe("string");
    expect(stored as string).not.toMatch(CONTROL_CHAR_RE);
    expect(stored).toBe(sanitizeErrorText(DIRTY_REASON));
  });

  it("updateTaskState without failureReason still writes NULL", async () => {
    await updateTaskState("task-3", "completed", { completedAt: new Date() });
    const q = captured.find((c) => c.sql.includes("failure_reason"));
    expect(q).toBeDefined();
    expect(q?.values).toContain(null);
  });
});
