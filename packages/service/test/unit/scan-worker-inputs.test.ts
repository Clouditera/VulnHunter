import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STATIC_ONLY_SCHED_INSTR,
  assertDynamicInputPolicy,
  scanInputEnvFromMeta,
} from "../../src/features/workers/scan-worker.js";

const script = fileURLToPath(new URL("../../../../worker-assets/scan-mode.sh", import.meta.url));

function captureArgv(env: Record<string, string> = {}): { argv: string[]; stderr: string } {
  const result = spawnSync("bash", ["-c", 'source "$1"; build_youngflow_args; log_input_summary; printf "%s\\0" "${YOUNGFLOW_ARGS[@]}"', "argv-test", script], {
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
    encoding: null,
  });
  expect(result.status, result.stderr?.toString()).toBe(0);
  return {
    argv: result.stdout.toString("utf8").split("\0").filter(Boolean),
    stderr: result.stderr.toString("utf8"),
  };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

describe("scanInputEnvFromMeta", () => {
  it("maps canonical fields and prefers canonical user_instr over legacy audit_focus", () => {
    expect(scanInputEnvFromMeta({
      audit_scope: "  whole project  ",
      vuln_focus: " auth and RCE ",
      user_instr: " canonical\nvalue ",
      audit_focus: "legacy value",
      output_language: " en ",
    })).toEqual({
      VULNFORGE_AUDIT_SCOPE: "whole project",
      VULNFORGE_VULN_FOCUS: "auth and RCE",
      VULNFORGE_SCHED_INSTR: STATIC_ONLY_SCHED_INSTR,
      VULNFORGE_USER_INSTR: "canonical\nvalue",
      VULNFORGE_OUTPUT_LANGUAGE: "en",
    });
  });

  it("falls back to legacy audit_focus and ignores non-string canonical values", () => {
    expect(scanInputEnvFromMeta({ user_instr: { unsafe: true }, audit_focus: " legacy " })).toMatchObject({
      VULNFORGE_USER_INSTR: "legacy",
    });
    expect(scanInputEnvFromMeta({ audit_scope: 123, vuln_focus: null })).toMatchObject({
      VULNFORGE_AUDIT_SCOPE: "",
      VULNFORGE_VULN_FOCUS: "",
    });
  });

  it("omits whitespace-only values and rejects NUL", () => {
    expect(scanInputEnvFromMeta({ audit_scope: " \n ", audit_focus: "\t" })).toMatchObject({
      VULNFORGE_AUDIT_SCOPE: "",
      VULNFORGE_USER_INSTR: "",
    });
    expect(() => scanInputEnvFromMeta({ user_instr: "bad\0value" })).toThrow(/Invalid NUL/);
  });

  it("ignores legacy dynamic-control metadata", () => {
    const env = scanInputEnvFromMeta({ enable_poc: true, enable_exp: true, sandbox_cfg: "/tmp/user.yaml" });
    expect(env).not.toHaveProperty("enable_poc");
    expect(env).not.toHaveProperty("enable_exp");
    expect(env).not.toHaveProperty("sandbox_cfg");
  });

  it("dynamic mode: drops static-only sched_instr, emits enable flags + dynamic marker", () => {
    const env = scanInputEnvFromMeta(
      { audit_scope: "scope", sched_instr: "  focus poc first ", enable_chain: true },
      { dynamicEnabled: true },
    );
    expect(env).toEqual({
      VULNFORGE_AUDIT_SCOPE: "scope",
      VULNFORGE_VULN_FOCUS: "",
      VULNFORGE_USER_INSTR: "",
      VULNFORGE_OUTPUT_LANGUAGE: "",
      VULNFORGE_DYNAMIC_ENABLED: "true",
      VULNFORGE_SCHED_INSTR: "focus poc first",
      VULNFORGE_ENABLE_POC: "true",
      VULNFORGE_ENABLE_EXP: "true",
      VULNFORGE_ENABLE_CHAIN: "true",
    });
  });

  it("dynamic mode without enable_chain/sched_instr: chain false, sched_instr empty (flow default)", () => {
    const env = scanInputEnvFromMeta({}, { dynamicEnabled: true });
    expect(env.VULNFORGE_ENABLE_CHAIN).toBe("false");
    expect(env.VULNFORGE_SCHED_INSTR).toBe("");
    expect(env.VULNFORGE_SCHED_INSTR).not.toBe(STATIC_ONLY_SCHED_INSTR);
  });
});

describe("dynamic policy invariants", () => {
  it("rejects EXP without POC and dynamic without sandbox", () => {
    expect(() => assertDynamicInputPolicy(false, true, "/validated/sandbox.yaml")).toThrow(/requires enable_poc/);
    expect(() => assertDynamicInputPolicy(true, false)).toThrow(/validated sandbox_cfg/);
    expect(() => assertDynamicInputPolicy(true, true, "  ")).toThrow(/validated sandbox_cfg/);
    expect(() => assertDynamicInputPolicy(false, false)).not.toThrow();
    expect(() => assertDynamicInputPolicy(true, true, "/validated/sandbox.yaml")).not.toThrow();
  });
});

describe("scan-mode VulnForge 2.0 argv contract", () => {
  it("A01 emits defaults/static gate in deterministic order", () => {
    const { argv } = captureArgv();
    expect(argv).toEqual([
      "/opt/vulnhunter/flows/vulnforge/flow.audit.yaml",
      "--work-dir", "/workspace/src",
      "--output-dir", "/workspace/out",
      "--json-log",
      "--max-parallel", "3",
      "--sched-instr", STATIC_ONLY_SCHED_INSTR,
      "--enable-poc", "false",
      "--enable-exp", "false",
    ]);
  });

  it("A02/A03/A07 map canonical text and keep legacy out of argv", () => {
    const mapped = scanInputEnvFromMeta({
      audit_scope: "scope",
      vuln_focus: "focus",
      user_instr: "canonical",
      audit_focus: "legacy",
      output_language: "en",
    });
    const { argv } = captureArgv(mapped);
    expect(valueAfter(argv, "--audit-scope")).toBe("scope");
    expect(valueAfter(argv, "--vuln-focus")).toBe("focus");
    expect(valueAfter(argv, "--user-instr")).toBe("canonical");
    expect(valueAfter(argv, "--output-language")).toBe("en");
    expect(argv).not.toContain("legacy");

    const legacy = captureArgv(scanInputEnvFromMeta({ audit_focus: "重点认证" })).argv;
    expect(valueAfter(legacy, "--user-instr")).toBe("重点认证");
  });

  it("A04 omits normalized empty optional text", () => {
    const { argv } = captureArgv(scanInputEnvFromMeta({ audit_scope: " \n", vuln_focus: "\t", user_instr: "  ", output_language: "  " }));
    expect(argv).not.toContain("--audit-scope");
    expect(argv).not.toContain("--vuln-focus");
    expect(argv).not.toContain("--user-instr");
    expect(argv).not.toContain("--output-language");
  });

  it("A05 preserves shell payload as one value and cannot alter dynamic flags", () => {
    const marker = `/tmp/m1-02-pwn-${process.pid}`;
    rmSync(marker, { force: true });
    const special = `$(touch ${marker}); --enable-poc true\nsecond line \"quoted\"`;
    const { argv, stderr } = captureArgv({ VULNFORGE_USER_INSTR: special });
    expect(valueAfter(argv, "--user-instr")).toBe(special);
    expect(argv.filter((value) => value === "--enable-poc")).toHaveLength(1);
    expect(valueAfter(argv, "--enable-poc")).toBe("false");
    expect(existsSync(marker)).toBe(false);
    expect(stderr).not.toContain(special);
    expect(stderr).not.toContain("second line");
  });

  it("A06 ignores dynamic env/metadata and never emits a sandbox flag", () => {
    const { argv } = captureArgv({
      VULNFORGE_ENABLE_POC: "true",
      VULNFORGE_ENABLE_EXP: "true",
      VULNFORGE_SANDBOX_CFG: "/tmp/user.yaml",
      ENABLE_POC: "true",
      ENABLE_EXP: "true",
      SANDBOX_CFG: "/tmp/other.yaml",
    });
    expect(valueAfter(argv, "--enable-poc")).toBe("false");
    expect(valueAfter(argv, "--enable-exp")).toBe("false");
    expect(argv).not.toContain("--sandbox-cfg");
    expect(argv).not.toContain("--sandbox-config");
  });

  it("H1 dynamic argv: enable flags + sandbox cfg, no static-only sched_instr", () => {
    const { argv } = captureArgv({
      VULNFORGE_DYNAMIC_ENABLED: "true",
      VULNFORGE_ENABLE_POC: "true",
      VULNFORGE_ENABLE_EXP: "true",
      VULNFORGE_ENABLE_CHAIN: "true",
      VULNFORGE_SANDBOX_CFG: "/run/vulnhunter/sandbox.md",
    });
    expect(argv).not.toContain(STATIC_ONLY_SCHED_INSTR);
    expect(argv).not.toContain("--sched-instr");
    expect(valueAfter(argv, "--enable-poc")).toBe("true");
    expect(valueAfter(argv, "--enable-exp")).toBe("true");
    expect(valueAfter(argv, "--enable-chain")).toBe("true");
    expect(valueAfter(argv, "--sandbox-cfg")).toBe("/run/vulnhunter/sandbox.md");
  });

  it("H1 dynamic argv: task sched_instr passes through; chain defaults off; missing sandbox_cfg omitted", () => {
    const withInstr = captureArgv({
      VULNFORGE_DYNAMIC_ENABLED: "true",
      VULNFORGE_ENABLE_POC: "true",
      VULNFORGE_ENABLE_EXP: "true",
      VULNFORGE_SCHED_INSTR: "prioritize poc-verify",
      VULNFORGE_SANDBOX_CFG: "/run/vulnhunter/sandbox.md",
    });
    expect(valueAfter(withInstr.argv, "--sched-instr")).toBe("prioritize poc-verify");
    expect(valueAfter(withInstr.argv, "--enable-chain")).toBe("false");
    const noCfg = captureArgv({ VULNFORGE_DYNAMIC_ENABLED: "true" });
    expect(noCfg.argv).not.toContain("--sandbox-cfg");
  });

  it("A08/A09 preserve continue and resume placement", () => {
    const continued = captureArgv({ VULNFORGE_USER_INSTR: "new focus", CONTINUE: "1" }).argv;
    expect(valueAfter(continued, "--user-instr")).toBe("new focus");
    expect(continued.at(-1)).toBe("--continue");

    const resumed = captureArgv({ VULNFORGE_AUDIT_SCOPE: "scope", RESUME: "1" }).argv;
    expect(valueAfter(resumed, "--audit-scope")).toBe("scope");
    expect(resumed.at(-1)).toBe("--resume");
  });

  it("A10/A12 source and logs contain no legacy flags or input bodies", () => {
    const source = readFileSync(script, "utf8");
    expect(source).not.toContain("--user-instruction");
    expect(source).not.toContain("--sandbox-config");
    expect(source).not.toContain("VULNFORGE_ARGV_TEST_MODE");
    const { stderr } = captureArgv({
      VULNFORGE_AUDIT_SCOPE: "secret-scope-body",
      VULNFORGE_VULN_FOCUS: "secret-focus-body",
      VULNFORGE_USER_INSTR: "secret-user-body",
      VULNFORGE_SCHED_INSTR: "secret-sched-body",
    });
    expect(stderr).not.toContain("secret-scope-body");
    expect(stderr).not.toContain("secret-focus-body");
    expect(stderr).not.toContain("secret-user-body");
    expect(stderr).not.toContain("secret-sched-body");
    expect(stderr).toContain("enable_poc=false enable_exp=false sandbox_cfg_present=false");
    expect(stderr).toContain(`sched_instr_chars=${[..."secret-sched-body"].length}`);
  });

  it("uses trusted deadline provenance and never normalizes arbitrary 137/OOM", () => {
    const source = readFileSync(script, "utf8");
    expect(source).toContain("run-with-deadline.py");
    expect(source).toContain('if [ "$analysis_exit" -eq 124 ]');
    expect(source).not.toMatch(/timeout --signal|\"137\".*normal termination|analysis_exit.*137/);
  });

  it("formal entry cannot be bypassed by legacy test-mode or FLOW_DIR env", () => {
    const result = spawnSync("bash", [script], {
      env: {
        PATH: process.env.PATH ?? "",
        VULNFORGE_ARGV_TEST_MODE: "1",
        FLOW_DIR: "/tmp/untrusted-flow",
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TASK_ID is required");

    const { argv } = captureArgv({ FLOW_DIR: "/tmp/untrusted-flow" });
    expect(argv[0]).toBe("/opt/vulnhunter/flows/vulnforge/flow.audit.yaml");
  });
});
