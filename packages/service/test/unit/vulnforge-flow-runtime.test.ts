import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlow } from "../../../../submodules/youngflow/src/spec.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const sourceFlowDir = join(repoRoot, "flows/vulnforge");
let runtimeFlowDir = "";
let flowPath = "";

beforeAll(() => {
  runtimeFlowDir = mkdtempSync(join(tmpdir(), "vulnforge-runtime-flow-"));
  flowPath = join(runtimeFlowDir, "flow.audit.yaml");
  writeFileSync(flowPath, readFileSync(join(sourceFlowDir, "flow.audit.yaml")));
  writeFileSync(join(runtimeFlowDir, "models.json"), '{"providers":{}}\n');
  for (const name of ["agents", "skills", "tasks", "templates", "schemas", "extensions"]) {
    symlinkSync(join(sourceFlowDir, name), join(runtimeFlowDir, name), "dir");
  }
});

afterAll(() => rmSync(runtimeFlowDir, { recursive: true, force: true }));

describe("VulnForge 2.0 runtime flow compatibility", () => {
  it("passes the real YoungFlow parser and keeps per-stage tool boundaries", () => {
    const spec = parseFlow(flowPath);
    const byId = new Map(spec.stages.map((stage) => [stage.id, stage]));

    expect(spec.defaultTools).toEqual(["read", "bash", "write", "edit"]);
    expect(byId.get("decide")?.tools).toEqual([
      "read", "bash", "write", "edit", "coverage", "workspace_diff", "workspace_snapshot",
    ]);
    expect(byId.get("report")?.tools).toEqual(["read", "bash", "write", "edit", "coverage"]);
    for (const id of ["onboard", "cognize", "hunt", "verify", "poc-verify", "exp-build", "cycle_join", "complete", "exit"]) {
      expect(byId.get(id)?.tools, `${id} must inherit only defaults`).toBeUndefined();
    }
  });

  it("preserves the decide spiral stable-session contract", () => {
    const decide = parseFlow(flowPath).stages.find((stage) => stage.id === "decide");
    expect(decide?.session.reuse).toBe(true);
    expect(decide?.session.compactAt).toBe(0.75);
    expect(decide?.session.prompt).toContain("进入新一轮调度决策");
  });
});
