import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B1 (HALL-35 review): `--enable-poc` / `--enable-exp` stay the public input
 * contract; the local entry wrapper `scripts/run-audit.sh` derives the engine
 * gate config (dynamic.yaml) from them so old invocations keep working —
 * no silent dual source of truth.
 */

const script = fileURLToPath(new URL("../../../../flows/vulnforge/scripts/run-audit.sh", import.meta.url));

function runBash(code: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", `source "$1"; ${code}`, "wrapper-test", script, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeGateConfig(pocRaw: string, expRaw: string): string {
  const outDir = mkdtempSync(join(tmpdir(), "run-audit-dynamic-"));
  const r = runBash(`write_gate_config "$2" "${pocRaw}" "${expRaw}" || true`, outDir);
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(join(outDir, "dynamic.yaml"), "utf8");
}

describe("run-audit.sh flag parsing (B1)", () => {
  it("captures enable/output flags from a full youngflow invocation", () => {
    const r = runBash(
      `dynamic_flags_from_args flow.audit.yaml --work-dir /src --output-dir /out --enable-poc 1 --enable-exp true --max-parallel 20; ` +
        `printf '%s|%s|%s' "$ENABLE_POC_RAW" "$ENABLE_EXP_RAW" "$OUT_DIR"`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("1|true|/out");
  });

  it("supports --flag=value forms", () => {
    const r = runBash(
      `dynamic_flags_from_args flow.audit.yaml --enable-poc=true --output-dir=/out; ` +
        `printf '%s|%s' "$ENABLE_POC_RAW" "$OUT_DIR"`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("true|/out");
  });

  it("falls back to work-dir as output dir (youngflow default), then fail-closed", () => {
    const r = runBash(
      `dynamic_flags_from_args flow.audit.yaml --work-dir /src --enable-poc 1; ` +
        `printf '%s|%s' "$OUT_DIR" "$ENABLE_POC_RAW"`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("/src|1");
  });

  it("defaults both switches off when no flags are given", () => {
    const r = runBash(
      `dynamic_flags_from_args flow.audit.yaml --work-dir /src; ` +
        `printf '%s|%s' "$ENABLE_POC_RAW" "$ENABLE_EXP_RAW"`,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("false|false");
  });
});

describe("run-audit.sh gate config writer (B1)", () => {
  it.each([
    ["1", "0", "true", "false"],
    ["true", "false", "true", "false"],
    ["false", "false", "false", "false"],
    ["", "", "false", "false"],
    ["yes", "on", "true", "true"],
    ["garbage", "false", "false", "false"],
  ])("poc=%s exp=%s → dynamic.yaml poc=%s exp=%s (fail-closed on unknown)", (pocRaw, expRaw, pocYaml, expYaml) => {
    expect(writeGateConfig(pocRaw, expRaw)).toBe(
      `version: 1\ndynamic:\n  poc_enabled: ${pocYaml}\n  exp_enabled: ${expYaml}\n`,
    );
  });

  it("writes the gate config before handing off to youngflow (single entry contract)", () => {
    const text = readFileSync(script, "utf8");
    const writeIndex = text.lastIndexOf("write_gate_config");
    const execIndex = text.indexOf("exec youngflow");
    expect(writeIndex).toBeGreaterThan(-1);
    expect(execIndex).toBeGreaterThan(writeIndex);
  });
});
