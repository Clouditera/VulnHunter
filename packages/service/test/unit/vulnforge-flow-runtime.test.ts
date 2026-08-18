import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlow } from "../../../../submodules/youngflow/src/spec.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const sourceFlowDir = join(repoRoot, "flows/vulnforge");
const sourceTimeoutDir = join(repoRoot, "flows/vulnforge-timeout");
let runtimeRoot = "";
let flowPath = "";
let timeoutFlowPath = "";

beforeAll(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "vulnforge-runtime-flows-"));
  const runtimeFlowDir = join(runtimeRoot, "vulnforge");
  const runtimeTimeoutDir = join(runtimeRoot, "vulnforge-timeout");
  mkdirSync(runtimeFlowDir); mkdirSync(runtimeTimeoutDir);
  flowPath = join(runtimeFlowDir, "flow.audit.yaml");
  timeoutFlowPath = join(runtimeTimeoutDir, "flow.timeout-finalize.yaml");
  writeFileSync(flowPath, readFileSync(join(sourceFlowDir, "flow.audit.yaml")));
  writeFileSync(timeoutFlowPath, readFileSync(join(sourceTimeoutDir, "flow.timeout-finalize.yaml")));
  writeFileSync(join(runtimeFlowDir, "models.json"), '{"providers":{}}\n');
  writeFileSync(join(runtimeFlowDir, ".env"), "V_DEFAULT_MODEL=platform/test\n");
  for (const name of ["agents", "skills", "tasks", "templates", "schemas", "extensions"]) {
    symlinkSync(join(sourceFlowDir, name), join(runtimeFlowDir, name), "dir");
  }
  symlinkSync(join(sourceTimeoutDir, "tasks"), join(runtimeTimeoutDir, "tasks"), "dir");
  symlinkSync("../vulnforge/schemas", join(runtimeTimeoutDir, "schemas"));
});

afterAll(() => rmSync(runtimeRoot, { recursive: true, force: true }));

describe("VulnForge 2.0 runtime flow compatibility", () => {
  it("passes the real YoungFlow parser and keeps per-stage tool boundaries", () => {
    const spec = parseFlow(flowPath);
    const byId = new Map(spec.stages.map((stage) => [stage.id, stage]));

    expect(spec.defaultTools).toEqual(["read", "bash", "write", "edit"]);
    expect(byId.get("decide")?.tools).toEqual([
      "read", "bash", "write", "edit", "coverage", "workspace_diff", "workspace_snapshot",
    ]);
    expect(byId.get("report")?.tools).toEqual(["read", "bash", "write", "edit", "coverage"]);
    // onboard owns the gate tools (v2 prepare internalization) — everything
    // else inherits defaults only.
    expect(byId.get("onboard")?.tools).toEqual(["list_sandbox_types", "get_sandbox_type"]);
    for (const id of ["cognize", "hunt", "verify", "poc-verify", "ev-assess", "exp-build", "cycle_join", "complete", "exit"]) {
      expect(byId.get(id)?.tools, `${id} must inherit only defaults`).toBeUndefined();
    }
  });

  it("locks the 1782ef6 decide contract: no session reuse, continuity via workspace state", () => {
    // Engine 692cfb3 deliberately removed decide session reuse (stability fix:
    // continuity is carried by workspace state instead of a stable session).
    const decide = parseFlow(flowPath).stages.find((stage) => stage.id === "decide");
    expect(decide?.session.reuse).toBe(false);
    expect(decide?.session.prompt).toBeUndefined();
  });

  it("exposes the three-tier dynamic gates with safe defaults", () => {
    const inputs = new Map(parseFlow(flowPath).inputs.map((input) => [input.name, input]));
    for (const gate of ["enable_poc", "enable_exp", "enable_chain"]) {
      expect(inputs.has(gate), `${gate} input must exist`).toBe(true);
      expect(inputs.get(gate)?.default, `${gate} must default off`).toBe("false");
    }
    expect(inputs.get("sandbox_cfg")?.default).toBe("");
  });

  it("keeps the timeout finalizer single-stage, bounded, and non-dynamic", () => {
    const spec = parseFlow(timeoutFlowPath);
    expect(spec.stages).toHaveLength(1);
    expect(spec.inputs.map((input) => input.name).sort()).toEqual([
      "analysis_limit_seconds", "artifact_inventory", "output_dir", "work_dir",
    ]);
    expect(spec.stages[0]).toMatchObject({
      id: "report",
      type: "single",
      timeout: 600,
      errorStrategy: "stop",
      tools: ["read", "write"],
      extensions: ["output-contract"],
      routes: [],
    });
    expect(spec.stages[0].tools).not.toEqual(expect.arrayContaining(["bash", "edit", "coverage"]));
  });

  it("uses the exact tracked relative schema SSOT symlink", () => {
    const link = join(sourceTimeoutDir, "schemas");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../vulnforge/schemas");
  });
});
