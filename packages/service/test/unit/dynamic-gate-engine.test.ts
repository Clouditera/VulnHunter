import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectFiles } from "../../../../submodules/youngflow/src/map-filter.js";
import { evaluateRouteDecision } from "../../../../submodules/youngflow/src/orchestrator.js";
import { parseFlow } from "../../../../submodules/youngflow/src/spec.js";
import type { StageSpec } from "../../../../submodules/youngflow/src/spec.js";
import { extractState } from "../../../../submodules/youngflow/src/state.js";

/**
 * HALL-35 engine-level dynamic gate semantics.
 *
 * The poc-verify / ev-assess chain is scheduled by the YoungFlow engine off
 * finding state (report.yaml) and a platform-written dynamic.yaml — model
 * scheduling can no longer skip dynamic verification. These tests drive the
 * real engine primitives (state extraction, route evaluation, map filtering)
 * against fixture workspaces to pin the routing matrix.
 */

const repoRoot = join(import.meta.dirname, "../../../..");
const sourceFlowDir = join(repoRoot, "flows/vulnforge");

let workspaceRoot = "";
let flowPath = "";

function writeFinding(id: string, metadata: Record<string, unknown>): string {
  const dir = join(workspaceRoot, "findings", id);
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "report.yaml");
  writeFileSync(
    report,
    [
      "metadata:",
      `  title: ${id}`,
      "  finding_class: vulnerability",
      `  poc_status: ${metadata.poc_status}`,
      `  exp_status: ${metadata.exp_status}`,
      "description:",
      "  background: fixture",
      "  detailed_description: fixture",
      "code:",
      "  dataflow:",
      "    - step: 1",
      "      location: a.ts:1",
      "      description: fixture",
      "",
    ].join("\n"),
  );
  return report;
}

function writeDynamicConfig(pocEnabled: boolean, expEnabled: boolean): void {
  writeFileSync(
    join(workspaceRoot, "dynamic.yaml"),
    `version: 1\ndynamic:\n  poc_enabled: ${pocEnabled}\n  exp_enabled: ${expEnabled}\n`,
  );
}

function stage(id: string): StageSpec {
  const found = byId.get(id);
  if (!found) throw new Error(`stage ${id} not found in flow.audit.yaml`);
  return found;
}

function gateTargets(stage: StageSpec): string[] {
  const rules = stage.stateExtract ? stage.stateExtract.rules : {};
  const extracted = { [stage.id]: extractState(rules, workspaceRoot) };
  return evaluateRouteDecision(stage, extracted, {}, false).targets;
}

let byId: Map<string, StageSpec>;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "vulnforge-dynamic-gate-"));
  const runtimeFlowDir = join(
    mkdtempSync(join(tmpdir(), "vulnforge-dynamic-gate-flows-")),
    "vulnforge",
  );
  mkdirSync(runtimeFlowDir);
  flowPath = join(runtimeFlowDir, "flow.audit.yaml");
  writeFileSync(flowPath, readFileSync(join(sourceFlowDir, "flow.audit.yaml")));
  writeFileSync(join(runtimeFlowDir, "models.json"), '{"providers":{}}\n');
  for (const name of ["agents", "skills", "tasks", "templates", "schemas", "extensions"]) {
    symlinkSync(join(sourceFlowDir, name), join(runtimeFlowDir, name), "dir");
  }
  byId = new Map(parseFlow(flowPath).stages.map((stage) => [stage.id, stage]));
});

afterAll(() => rmSync(workspaceRoot, { recursive: true, force: true }));

describe("dynamic.yaml gate state extraction", () => {
  it("reads platform-written booleans", () => {
    writeDynamicConfig(true, true);
    expect(gateTargets(stage("poc_gate"))).toEqual(["poc-verify"]);
    expect(gateTargets(stage("exp_gate"))).toEqual(["ev-assess"]);
    expect(gateTargets(stage("poc-verify"))).toEqual(["ev-assess"]);
    writeDynamicConfig(true, false);
    expect(gateTargets(stage("exp_gate"))).toEqual(["cycle_join"]);
    expect(gateTargets(stage("poc-verify"))).toEqual(["cycle_join"]);
  });

  it("fails loud when the platform forgot to write dynamic.yaml", () => {
    rmSync(join(workspaceRoot, "dynamic.yaml"));
    expect(() => gateTargets(stage("poc_gate"))).toThrow(/dynamic\.yaml/);
    writeDynamicConfig(false, false);
  });
});

describe("gate routing matrix (static isolation included)", () => {
  it.each([
    { poc: true, exp: true, expected: ["poc-verify"] },
    { poc: false, exp: true, expected: ["exp_gate"] },
    { poc: false, exp: false, expected: ["exp_gate"] },
  ])("poc_gate with dynamic=$poc/$exp routes to $expected", ({ poc, exp, expected }) => {
    writeDynamicConfig(poc, exp);
    expect(gateTargets(stage("poc_gate"))).toEqual(expected);
  });

  it.each([
    { exp: true, expected: ["ev-assess"] },
    { exp: false, expected: ["cycle_join"] },
  ])("exp_gate with exp=$exp routes to $expected", ({ exp, expected }) => {
    writeDynamicConfig(false, exp);
    expect(gateTargets(stage("exp_gate"))).toEqual(expected);
  });

  it("never starts a dynamic worker while both switches are off, even with pending findings present", () => {
    writeFinding("BUG-R1-C1-A1-H1", { poc_status: "pending", exp_status: "awaiting-poc" });
    writeDynamicConfig(false, false);
    const reached = new Set<string>();
    let current: string | undefined = "poc_gate";
    // Walk the deterministic gate chain (no worker stage may appear).
    while (current && current !== "cycle_join") {
      reached.add(current);
      const targets = gateTargets(stage(current));
      current = targets[0];
      expect(reached.size).toBeLessThan(5);
    }
    expect(reached).toEqual(new Set(["poc_gate", "exp_gate"]));
  });

  it("routes poc-verify onward to ev-assess only when exp is enabled", () => {
    writeDynamicConfig(true, true);
    expect(gateTargets(stage("poc-verify"))).toEqual(["ev-assess"]);
    writeDynamicConfig(true, false);
    expect(gateTargets(stage("poc-verify"))).toEqual(["cycle_join"]);
  });

  it("ev-assess always returns to cycle_join", () => {
    writeDynamicConfig(true, true);
    expect(gateTargets(stage("ev-assess"))).toEqual(["cycle_join"]);
  });
});

describe("finding map filters (report.yaml is the single state source)", () => {
  let files: string[];

  beforeAll(() => {
    writeDynamicConfig(true, true);
    writeFinding("BUG-R1-C1-A1-H1", { poc_status: "pending", exp_status: "awaiting-poc" });
    writeFinding("BUG-R1-C1-A1-H2", { poc_status: "reproduced", exp_status: "pending" });
    writeFinding("BUG-R1-C1-A1-H3", { poc_status: "fail-reproduced", exp_status: "not-needed" });
    writeFinding("BUG-R1-C1-A1-H4", { poc_status: "blocked", exp_status: "blocked" });
    files = selectFiles(
      [1, 2, 3, 4]
        .map((n) => join(workspaceRoot, "findings", `BUG-R1-C1-A1-H${n}`, "report.yaml"))
        .sort(),
      undefined,
      "fixture",
    );
  });

  it("poc-verify consumes pending and blocked findings (blocked stays retryable, S3)", () => {
    const selected = selectFiles(files, stage("poc-verify").filter ?? undefined, "poc-verify");
    expect(selected).toEqual([
      join(workspaceRoot, "findings", "BUG-R1-C1-A1-H1", "report.yaml"),
      join(workspaceRoot, "findings", "BUG-R1-C1-A1-H4", "report.yaml"),
    ]);
  });

  it("ev-assess consumes exactly the exp_status=pending findings", () => {
    const selected = selectFiles(files, stage("ev-assess").filter ?? undefined, "ev-assess");
    expect(selected).toEqual([join(workspaceRoot, "findings", "BUG-R1-C1-A1-H2", "report.yaml")]);
  });

  it("keeps legacy exp_status=pending findings visible to ev-assess (worker entry re-checks poc_status)", () => {
    const legacy = writeFinding("BUG-legacy", { poc_status: "pending", exp_status: "pending" });
    const selected = selectFiles(
      [...files, legacy].sort(),
      stage("ev-assess").filter ?? undefined,
      "ev-assess",
    );
    expect(selected).toEqual(expect.arrayContaining([legacy]));
    // …but they stay pending for poc-verify too, so PoC still runs first.
    const pocSelected = selectFiles(
      [...files, legacy].sort(),
      stage("poc-verify").filter ?? undefined,
      "poc-verify",
    );
    expect(pocSelected).toEqual(expect.arrayContaining([legacy]));
  });

  it("skips unparseable report.yaml files instead of crashing the stage", () => {
    const broken = join(workspaceRoot, "findings", "BUG-broken", "report.yaml");
    mkdirSync(join(workspaceRoot, "findings", "BUG-broken"), { recursive: true });
    writeFileSync(broken, "metadata: [unparseable\n");
    const selected = selectFiles(
      [broken, ...files].sort(),
      stage("poc-verify").filter ?? undefined,
      "poc-verify",
    );
    expect(selected).not.toContain(broken);
  });
});
