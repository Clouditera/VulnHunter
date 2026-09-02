import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * HALL-35: scan-mode.sh writes the engine-read dynamic gate config
 * (dynamic.yaml) from trusted platform env — the flow's poc_gate / exp_gate
 * join stages route on it, so the file must exist for every spawn and must
 * never enable dynamic work on a static run.
 */

const script = fileURLToPath(new URL("../../../../worker-assets/scan-mode.sh", import.meta.url));

function writeDynamicConfig(env: Record<string, string>): string {
  const outDir = mkdtempSync(join(tmpdir(), "scan-mode-dynamic-"));
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; OUT_DIR="$2" write_dynamic_config', "cfg-test", script, outDir],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(outDir, "dynamic.yaml"), "utf8");
}

describe("scan-mode dynamic.yaml writer (HALL-35)", () => {
  it("dynamic run maps the enable flags verbatim", () => {
    expect(
      writeDynamicConfig({
        VULNFORGE_DYNAMIC_ENABLED: "true",
        VULNFORGE_ENABLE_POC: "true",
        VULNFORGE_ENABLE_EXP: "false",
      }),
    ).toBe("version: 1\ndynamic:\n  poc_enabled: true\n  exp_enabled: false\n");

    expect(
      writeDynamicConfig({
        VULNFORGE_DYNAMIC_ENABLED: "true",
        VULNFORGE_ENABLE_POC: "true",
        VULNFORGE_ENABLE_EXP: "true",
      }),
    ).toBe("version: 1\ndynamic:\n  poc_enabled: true\n  exp_enabled: true\n");
  });

  it("dynamic run without enable flags defaults both off", () => {
    expect(writeDynamicConfig({ VULNFORGE_DYNAMIC_ENABLED: "true" })).toBe(
      "version: 1\ndynamic:\n  poc_enabled: false\n  exp_enabled: false\n",
    );
  });

  it("static run hard-gates both switches off even if enable env leaks in", () => {
    expect(
      writeDynamicConfig({
        VULNFORGE_DYNAMIC_ENABLED: "false",
        VULNFORGE_ENABLE_POC: "true",
        VULNFORGE_ENABLE_EXP: "true",
      }),
    ).toBe("version: 1\ndynamic:\n  poc_enabled: false\n  exp_enabled: false\n");
    expect(writeDynamicConfig({})).toBe(
      "version: 1\ndynamic:\n  poc_enabled: false\n  exp_enabled: false\n",
    );
  });

  it("is wired into main after the output-dir reset (fresh and continue spawns both get it)", () => {
    const text = readFileSync(script, "utf8");
    expect(text.match(/write_dynamic_config/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Written after `rm -rf /workspace/out` so a fresh spawn cannot lose it,
    // and re-written on --continue respawns so the trusted env stays current.
    const rmIndex = text.indexOf("rm -rf /workspace/out");
    const callIndex = text.indexOf(
      "write_dynamic_config",
      text.indexOf("write_dynamic_config") + 1,
    );
    expect(rmIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(rmIndex);
  });

  // I2 (review): write protection alone is not enough — a static run must
  // fail loud if dynamic.yaml is not double-false when the engine starts.
  describe("fail-closed verification (I2)", () => {
    function verifyDynamicConfig(env: Record<string, string>, yamlContent: string): number | null {
      const outDir = mkdtempSync(join(tmpdir(), "scan-mode-verify-"));
      writeFileSync(join(outDir, "dynamic.yaml"), yamlContent);
      const result = spawnSync(
        "bash",
        ["-c", 'source "$1"; OUT_DIR="$2" verify_dynamic_config', "cfg-verify", script, outDir],
        {
          env: { PATH: process.env.PATH ?? "", ...env },
          encoding: "utf8",
        },
      );
      return result.status;
    }

    it("static run accepts a matching double-false config", () => {
      expect(
        verifyDynamicConfig({}, "version: 1\ndynamic:\n  poc_enabled: false\n  exp_enabled: false\n"),
      ).toBe(0);
    });

    it("static run fails loud when dynamic.yaml enables anything (tamper/leak)", () => {
      expect(
        verifyDynamicConfig({}, "version: 1\ndynamic:\n  poc_enabled: true\n  exp_enabled: false\n"),
      ).not.toBe(0);
      expect(
        verifyDynamicConfig({}, "version: 1\ndynamic:\n  poc_enabled: false\n  exp_enabled: true\n"),
      ).not.toBe(0);
      // Tampered into an unexpected shape — also fatal, never silently static.
      expect(verifyDynamicConfig({}, "not: a-gate-config\n")).not.toBe(0);
      expect(verifyDynamicConfig({}, "\n")).not.toBe(0);
    });

    it("dynamic run verifies against the flags it computed", () => {
      const ok = verifyDynamicConfig(
        { VULNFORGE_DYNAMIC_ENABLED: "true", VULNFORGE_ENABLE_POC: "true", VULNFORGE_ENABLE_EXP: "false" },
        "version: 1\ndynamic:\n  poc_enabled: true\n  exp_enabled: false\n",
      );
      expect(ok).toBe(0);
    });

    it("is wired into main right after write_dynamic_config", () => {
      const text = readFileSync(script, "utf8");
      const writeCall = text.indexOf(
        "write_dynamic_config",
        text.indexOf("write_dynamic_config") + 1,
      );
      const verifyCall = text.indexOf(
        "verify_dynamic_config",
        text.indexOf("verify_dynamic_config") + 1,
      );
      expect(verifyCall).toBeGreaterThan(writeCall);
    });
  });
});
