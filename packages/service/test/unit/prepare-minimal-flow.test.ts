import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseFlow } from "../../../../submodules/youngflow/src/spec.js";

const root = join(import.meta.dirname, "../../../..");
const flowPath = join(root, "flows/prepare/flow.prepare.yaml");
const postflight = join(root, "worker-assets/prepare-result-postflight.py");

function validate(value: unknown, dynamic: boolean, profiles?: unknown, extra = false) {
  const dir = mkdtempSync(join(tmpdir(), "prepare-result-"));
  try {
    const result = join(dir, "prepare-result.json");
    writeFileSync(result, typeof value === "string" ? value : `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(result, 0o600);
    mkdirSync(join(dir, ".youngflow"));
    if (extra) writeFileSync(join(dir, "extra"), "x", { mode: 0o600 });
    const args = [postflight, dir, String(dynamic)];
    if (profiles !== undefined) {
      const file = join(tmpdir(), `prepare-profiles-${process.pid}-${Math.random()}.json`);
      writeFileSync(file, JSON.stringify(profiles)); args.push(file);
      const run = spawnSync("python3", args, { encoding: "utf8" }); rmSync(file, { force: true }); return run;
    }
    return spawnSync("python3", args, { encoding: "utf8" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("minimal Prepare flow", () => {
  it("is one standard single stage with only pi default tools", () => {
    const spec = parseFlow(flowPath);
    expect(spec.stages.map((x) => [x.id, x.type])).toEqual([["prepare", "single"]]);
    expect(spec.defaultTools).toEqual(["read", "write", "edit", "bash"]);
    const raw = readFileSync(flowPath, "utf8");
    for (const legacy of ["prepare-restricted", "prepare-tools", "submit_plan", "compact-submit"]) expect(raw).not.toContain(legacy);
  });

  it("keeps the inspection prompt short and forbids execution/install/test", () => {
    const text = readFileSync(join(root, "flows/prepare/agents/prepare-agent.md"), "utf8") + readFileSync(join(root, "flows/prepare/tasks/prepare.md"), "utf8");
    expect(text).toContain("Do not compile"); expect(text).toContain("Do not");
    expect(text).toContain("prepare-result.json"); expect(text).toContain("project_complete");
  });

  it("accepts only the four legal result combinations", () => {
    expect(validate({ project_complete: true, sandbox_type: null, reason: "complete" }, false).status).toBe(0);
    expect(validate({ project_complete: false, sandbox_type: null, reason: "partial_source" }, false).status).toBe(0);
    expect(validate({ project_complete: true, sandbox_type: "base-linux", reason: "complete" }, true, [{ profile_id: "base-linux" }]).status).toBe(0);
    expect(validate({ project_complete: true, sandbox_type: null, reason: "no_compatible_sandbox" }, true, []).status).toBe(0);
  });

  it("rejects malformed, extra, duplicate, invalid combination and invisible profile results", () => {
    const invalid: Array<[unknown, boolean, unknown?]> = [
      ["{", false],
      [{ project_complete: true, sandbox_type: null, reason: "complete", extra: 1 }, false],
      [{ project_complete: false, sandbox_type: null, reason: "complete" }, false],
      [{ project_complete: true, sandbox_type: "base-linux", reason: "complete" }, false],
      [{ project_complete: true, sandbox_type: "missing", reason: "complete" }, true, [{ profile_id: "base-linux" }]],
      ['{"project_complete":true,"project_complete":false,"sandbox_type":null,"reason":"partial_source"}', false],
    ];
    for (const [value, dynamic, profiles] of invalid) expect(validate(value, dynamic, profiles).status).toBe(4);
    expect(validate({ project_complete: true, sandbox_type: null, reason: "complete" }, false, undefined, true).status).toBe(4);
  });

  it("uses readonly source probing, standard YoungFlow work/output dirs, and postflight", () => {
    const mode = readFileSync(join(root, "worker-assets/prepare-mode.sh"), "utf8");
    expect(mode).toContain(".prepare-readonly-probe");
    expect(mode).toContain('--work-dir "$PREPARE_SOURCE_ROOT"');
    expect(mode).toContain('--output-dir "$PREPARE_OUTPUT_DIR"');
    expect(mode).toContain("prepare-result-postflight.py");
    for (const legacy of ["PREPARE_CONTROL_DIR", "PREPARE_PLANNER_INPUT", "PREPARE_PLAN_SCHEMA"]) expect(mode).not.toContain(legacy);
  });
});
