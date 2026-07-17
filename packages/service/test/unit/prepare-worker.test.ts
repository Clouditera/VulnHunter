import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDynamicEnabled, readPrepareResult, type PrepareResult } from "../../src/features/workers/prepare-worker.js";

describe("prepare-worker helpers", () => {
  it("isDynamicEnabled reads the source_meta.dynamic_enabled switch, default false", () => {
    expect(isDynamicEnabled({ source_meta: {} } as any)).toBe(false);
    expect(isDynamicEnabled({ source_meta: { dynamic_enabled: true } } as any)).toBe(true);
    expect(isDynamicEnabled({ source_meta: { dynamic_enabled: "true" } } as any)).toBe(true);
    expect(isDynamicEnabled({ source_meta: { dynamic_enabled: false } } as any)).toBe(false);
    expect(isDynamicEnabled({ source_meta: null } as any)).toBe(false);
  });

  it("readPrepareResult parses a valid three-field result", () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-result-"));
    try {
      const good: PrepareResult = { project_complete: true, sandbox_type: "base-linux", reason: "complete" };
      writeFileSync(join(dir, "prepare-result.json"), JSON.stringify(good));
      expect(readPrepareResult(dir)).resolves.toEqual(good);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPrepareResult fails closed on missing / malformed / wrong-shape results", () => {
    const missing = mkdtempSync(join(tmpdir(), "prepare-result-"));
    const malformed = mkdtempSync(join(tmpdir(), "prepare-result-"));
    const wrongShape = mkdtempSync(join(tmpdir(), "prepare-result-"));
    const badReason = mkdtempSync(join(tmpdir(), "prepare-result-"));
    try {
      writeFileSync(join(malformed, "prepare-result.json"), "{");
      writeFileSync(join(wrongShape, "prepare-result.json"), JSON.stringify({ project_complete: "yes", sandbox_type: null, reason: "complete" }));
      writeFileSync(join(badReason, "prepare-result.json"), JSON.stringify({ project_complete: true, sandbox_type: null, reason: "bogus" }));
      return Promise.all([
        expect(readPrepareResult(missing)).rejects.toThrow(),
        expect(readPrepareResult(malformed)).rejects.toThrow(),
        expect(readPrepareResult(wrongShape)).rejects.toThrow(),
        expect(readPrepareResult(badReason)).rejects.toThrow(),
      ]);
    } finally {
      for (const d of [missing, malformed, wrongShape, badReason]) rmSync(d, { recursive: true, force: true });
    }
  });
});
