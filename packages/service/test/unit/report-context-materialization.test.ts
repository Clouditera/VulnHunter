import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { extractArchiveToSource, safeContextFilename } from "../../src/features/reports/report-worker.js";

describe("safeContextFilename", () => {
  it("keeps finding keys filesystem-safe and traversal-free", () => {
    expect(safeContextFilename("BUG-HYP-R0/C0:源码")).toBe("BUG-HYP-R0_C0___");
    expect(safeContextFilename("../secret")).toBe(".._secret");
    expect(safeContextFilename("   ", "fallback")).toBe("fallback");
    expect(safeContextFilename("...", "fallback")).toBe("fallback");
  });
});

describe("extractArchiveToSource", () => {
  it("extracts tar.gz source archives into the report source directory", () => {
    const root = mkdtempSync(join(tmpdir(), "report-source-"));
    try {
      const inputDir = join(root, "input");
      const sourceDir = join(root, "source");
      mkdirSync(inputDir);
      mkdirSync(sourceDir);
      writeFileSync(join(inputDir, "app.c"), "int main(){return 0;}\n");
      const archive = join(root, "source.tar.gz");
      execSync(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(inputDir)} .`);

      extractArchiveToSource(archive, "source.tar.gz", sourceDir);

      expect(readFileSync(join(sourceDir, "app.c"), "utf-8")).toContain("int main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
