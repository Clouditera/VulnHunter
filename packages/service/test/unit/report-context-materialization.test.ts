import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  it("extracts tar.gz source archives into the report source directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-source-"));
    try {
      const inputDir = join(root, "input");
      const sourceDir = join(root, "source");
      mkdirSync(inputDir);
      mkdirSync(sourceDir);
      writeFileSync(join(sourceDir, "stale"), "remove me");
      writeFileSync(join(inputDir, "app.c"), "int main(){return 0;}\n");
      const archive = join(root, "source.tar.gz");
      execSync(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(inputDir)} .`);

      await extractArchiveToSource(archive, "source.tar.gz", sourceDir);

      expect(readFileSync(join(sourceDir, "app.c"), "utf-8")).toContain("int main");
      expect(existsSync(join(sourceDir, "stale"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves the report source destination absent after invalid extraction", async () => {
    const root = mkdtempSync(join(tmpdir(), "report-source-invalid-"));
    try {
      const sourceDir = join(root, "source");
      mkdirSync(sourceDir);
      writeFileSync(join(sourceDir, "stale"), "remove me");
      const archive = join(root, "source.tar.gz");
      writeFileSync(archive, "not an archive");

      await expect(extractArchiveToSource(archive, "source.tar.gz", sourceDir)).rejects.toBeTruthy();

      expect(existsSync(sourceDir)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(".source-extract-"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
