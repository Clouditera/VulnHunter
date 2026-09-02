import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFlow } from "../../../../submodules/youngflow/src/spec.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const sourceFlowDir = join(repoRoot, "flows/vulnforge");
let runtimeRoot = "";
let flowPath = "";

beforeAll(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "vulnforge-runtime-flows-"));
  const runtimeFlowDir = join(runtimeRoot, "vulnforge");
  mkdirSync(runtimeFlowDir);
  flowPath = join(runtimeFlowDir, "flow.audit.yaml");
  writeFileSync(flowPath, readFileSync(join(sourceFlowDir, "flow.audit.yaml")));
  writeFileSync(join(runtimeFlowDir, "models.json"), '{"providers":{}}\n');
  writeFileSync(join(runtimeFlowDir, ".env"), "V_DEFAULT_MODEL=platform/test\n");
  for (const name of ["agents", "skills", "tasks", "templates", "schemas", "extensions"]) {
    symlinkSync(join(sourceFlowDir, name), join(runtimeFlowDir, name), "dir");
  }
});

afterAll(() => rmSync(runtimeRoot, { recursive: true, force: true }));

describe("VulnForge 2.0 runtime flow compatibility", () => {
  it("passes the real YoungFlow parser and keeps per-stage tool boundaries", () => {
    const spec = parseFlow(flowPath);
    const byId = new Map(spec.stages.map((stage) => [stage.id, stage]));

    expect(spec.defaultTools).toEqual(["read", "bash", "write", "edit"]);
    expect(byId.get("decide")?.tools).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "coverage",
      "workspace_diff",
      "workspace_snapshot",
    ]);
    expect(byId.get("report")?.tools).toEqual(["read", "bash", "write", "edit", "coverage"]);
    // onboard owns the gate tools (v2 prepare internalization) AND the base
    // tools — youngflow REPLACES defaults with stage tools, so a stage-level
    // list must carry read/bash/write/edit too (P0 QA 7322dcde). Everything
    // else inherits defaults only.
    expect(byId.get("onboard")?.tools).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "list_sandbox_types",
      "get_sandbox_type",
      "apply_sandbox",
    ]);
    for (const id of [
      "cognize",
      "hunt",
      "verify",
      "poc-verify",
      "ev-assess",
      "exp-build",
      "cycle_join",
      "complete",
      "exit",
    ]) {
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

  // The timeout finalizer flow (flows/vulnforge-timeout) was retired
  // 2026-08-18 (fish): scan-mode writes the platform marker directly on 124;
  // its runtime tests moved to timeout-finalization.test.ts.

  it("engine-native gate: onboard binds gate.yaml state with end/continue routes, decide caps onboard loops", () => {
    const spec = parseFlow(flowPath);
    const byId = new Map(spec.stages.map((stage) => [stage.id, stage]));
    const onboard = byId.get("onboard");
    expect(onboard?.stateExtract).toMatchObject({
      rules: { next: { file: "gate.yaml", field: "next" } },
    });
    const routes = onboard?.routes ?? [];
    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: "exit", when: "onboard.next == end" }),
        expect.objectContaining({ to: "cycle_join", when: "onboard.next == continue" }),
      ]),
    );
    // decide→onboard idle-loop cap (replaces the retired platform watchdog)
    const decide = byId.get("decide");
    const onboardEdge = (decide?.routes ?? []).find((r) => r.to === "onboard");
    expect(onboardEdge?.maxLoops).toBe(5);
    // preprocessing skill mounted on onboard
    expect(onboard?.skills).toContain("preprocessing");
  });

  // HALL-35: poc-verify / ev-assess are engine-scheduled off finding state —
  // decide no longer creates POC-*/EXP-* todos, so weak models cannot skip
  // dynamic verification.
  describe("engine-scheduled dynamic verification (HALL-35)", () => {
    let byId: Map<string, ReturnType<typeof parseFlow>["stages"][number]>;

    beforeAll(() => {
      byId = new Map(parseFlow(flowPath).stages.map((stage) => [stage.id, stage]));
    });

    it("mounts poc_gate / exp_gate engine-only joins on dynamic.yaml", () => {
      const pocGate = byId.get("poc_gate");
      expect(pocGate?.type).toBe("join");
      expect(pocGate?.task).toBeUndefined();
      expect(pocGate?.stateExtract).toMatchObject({
        rules: { poc_enabled: { file: "dynamic.yaml", field: "dynamic.poc_enabled" } },
      });
      expect(pocGate?.routes ?? []).toEqual([
        expect.objectContaining({ to: "poc-verify", when: "poc_gate.poc_enabled == true" }),
        expect.objectContaining({ to: "exp_gate" }),
      ]);

      const expGate = byId.get("exp_gate");
      expect(expGate?.type).toBe("join");
      expect(expGate?.task).toBeUndefined();
      expect(expGate?.stateExtract).toMatchObject({
        rules: { exp_enabled: { file: "dynamic.yaml", field: "dynamic.exp_enabled" } },
      });
      expect(expGate?.routes ?? []).toEqual([
        expect.objectContaining({ to: "ev-assess", when: "exp_gate.exp_enabled == true" }),
        expect.objectContaining({ to: "cycle_join" }),
      ]);
    });

    it("verify always drains into the dynamic gate; legacy decide values route to the gates", () => {
      const verify = byId.get("verify");
      expect(verify?.routes ?? []).toEqual([expect.objectContaining({ to: "poc_gate" })]);

      const decide = byId.get("decide");
      const decideTargets = (decide?.routes ?? []).map((r) => r.to);
      // deprecated enum values survive for old workspaces but only reach the
      // deterministic gates — never the worker stages directly.
      expect(decideTargets).not.toContain("poc-verify");
      expect(decideTargets).not.toContain("ev-assess");
      // exp-build routing must not regress — it stays decide-dispatched.
      expect(decideTargets).toContain("exp-build");
      expect(decide?.routes ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: "poc_gate", when: "decide.next == poc-verify" }),
          expect.objectContaining({ to: "exp_gate", when: "decide.next == ev-assess" }),
        ]),
      );
    });

    it("poc-verify maps pending findings serially with an exp-aware exit route", () => {
      const poc = byId.get("poc-verify");
      expect(poc?.type).toBe("map");
      expect(poc?.over).toBe("findings/BUG-*/report.yaml");
      expect(poc?.overSource?.kind ?? "glob").toBe("glob");
      expect(poc?.filter).toMatchObject({ field: "metadata.poc_status", match: "pending" });
      expect(poc?.concurrency).toBe(1);
      expect(poc?.errorStrategy).toBe("continue");
      expect(poc?.stateExtract).toMatchObject({
        rules: { exp_enabled: { file: "dynamic.yaml", field: "dynamic.exp_enabled" } },
      });
      expect(poc?.routes ?? []).toEqual([
        expect.objectContaining({ to: "ev-assess", when: "poc-verify.exp_enabled == true" }),
        expect.objectContaining({ to: "cycle_join" }),
      ]);
    });

    it("ev-assess maps exp-ready findings serially", () => {
      const ev = byId.get("ev-assess");
      expect(ev?.type).toBe("map");
      expect(ev?.over).toBe("findings/BUG-*/report.yaml");
      expect(ev?.filter).toMatchObject({ field: "metadata.exp_status", match: "pending" });
      expect(ev?.concurrency).toBe(1);
      expect(ev?.errorStrategy).toBe("continue");
      expect(ev?.routes ?? []).toEqual([expect.objectContaining({ to: "cycle_join" })]);
    });

    it("retires todo/POC-* and todo/EXP-* consumption everywhere in the flow", () => {
      const flowText = readFileSync(flowPath, "utf8");
      expect(flowText).not.toContain("todo/POC-");
      expect(flowText).not.toContain("todo/EXP-");
      // decide no longer teaches the retired POC/EXP task contracts
      const decide = byId.get("decide");
      expect(decide?.prompt).not.toContain("poc.schema.yaml");
      expect(decide?.prompt).not.toContain("exp.schema.yaml");
      expect(decide?.prompt).not.toContain("poc.template.md");
      expect(decide?.prompt).not.toContain("exp.template.md");
      // workers receive the finding report directly
      expect(byId.get("poc-verify")?.prompt).toContain("${iterate_file}");
      expect(byId.get("ev-assess")?.prompt).toContain("${iterate_file}");
    });
  });
});
