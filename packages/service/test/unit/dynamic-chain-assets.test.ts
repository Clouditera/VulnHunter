import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * HALL-35 asset contract: tasks / schemas / templates / output-contract /
 * docs must match the engine-scheduled dynamic chain — decide no longer
 * creates POC/EXP todos, workers consume finding report.yaml directly.
 */

const flowDir = fileURLToPath(new URL("../../../../flows/vulnforge", import.meta.url));

function read(rel: string): string {
  return readFileSync(join(flowDir, rel), "utf8");
}

describe("task contracts (HALL-35)", () => {
  it("decide no longer creates or dispatches POC/EXP todos", () => {
    const decide = read("tasks/decide.md");
    expect(decide).not.toContain("todo/POC-");
    expect(decide).not.toContain("todo/EXP-");
    expect(decide).not.toMatch(/创建 `todo\/POC|创建 `todo\/EXP/);
    // worklog direction enum drops the engine-owned stages
    expect(decide).not.toMatch(/onboard \/ cognize \/ hunt \/ verify \/ poc-verify/);
  });

  it("verify initializes vulnerability findings with awaiting-poc", () => {
    const verify = read("tasks/verify-audit.md");
    expect(verify).toContain("awaiting-poc");
    expect(verify).not.toContain("exp_status` 置为 `pending`");
  });

  it("poc-verify consumes the finding report directly and advances exp_status atomically", () => {
    const poc = read("tasks/poc-verify.md");
    expect(poc).toContain("finding");
    expect(poc).not.toContain("todo/POC-");
    expect(poc).not.toMatch(/移动到 `done\/`/);
    // defensive class check (single-condition filter cannot express it)
    expect(poc).toMatch(/finding_class[^\n]*vulnerability|vulnerability[^\n]*finding_class/);
    // state machine: reproduced → pending, terminal outcomes otherwise
    expect(poc).toContain("awaiting-poc");
  });

  it("ev-assess defensively re-checks poc_status=reproduced at the worker entry", () => {
    const ev = read("tasks/ev-assess.md");
    expect(ev).not.toContain("todo/EXP-");
    expect(ev).not.toMatch(/移动到 `done\/`/);
    expect(ev).toMatch(/poc_status[^\n]*reproduced|reproduced[^\n]*poc_status/);
  });

  it("retries blocked PoCs on later verify rounds (poc_status filter includes blocked)", () => {
    const poc = read("tasks/poc-verify.md");
    expect(poc).toMatch(/blocked[^\n]*重试|重试[^\n]*blocked/);
    const flow = read("docs/flow-design/flow.md");
    // S3: blocked is NOT terminal — unified with the task contract.
    expect(flow).not.toMatch(/blocked[^\n]*(视为|终态，不做)/);
    expect(flow).toMatch(/blocked[^\n]*重试|重试[^\n]*blocked/);
  });

  it("flow input descriptions no longer claim decide dispatches the dynamic stages (S1)", () => {
    const flow = read("flow.audit.yaml");
    // Old decide-dispatch wording must be gone from enable_poc / enable_exp.
    expect(flow).not.toContain("decide 可为静态确认漏洞派发 poc-verify");
    expect(flow).not.toContain("decide 可为已 POC 复现的 vulnerability finding 派发 ev-assess");
    expect(flow).toMatch(/enable_poc:[\s\S]{0,220}dynamic\.yaml/);
    expect(flow).toMatch(/enable_exp:[\s\S]{0,220}dynamic\.yaml/);
  });
});

describe("schema contracts (HALL-35)", () => {
  it("bug-report exp_status enum carries awaiting-poc with the creation contract", () => {
    const schema = read("schemas/bug-report.schema.yaml");
    expect(schema).toContain("- awaiting-poc");
    expect(schema).toMatch(/awaiting-poc[^\n]*PoC/);
  });

  it("decision schema keeps deprecated legacy values documented as gate-routed", () => {
    const schema = read("schemas/decision.schema.yaml");
    expect(schema).toContain("poc-verify");
    expect(schema).toContain("ev-assess");
    expect(schema).toMatch(/deprecated|兼容历史/i);
  });

  it("retires the POC/EXP todo frontmatter schemas and templates", () => {
    expect(existsSync(join(flowDir, "schemas/poc.schema.yaml"))).toBe(false);
    expect(existsSync(join(flowDir, "schemas/exp.schema.yaml"))).toBe(false);
    expect(existsSync(join(flowDir, "templates/poc.template.md"))).toBe(false);
    expect(existsSync(join(flowDir, "templates/exp.template.md"))).toBe(false);
  });
});

describe("output-contract extension (HALL-35)", () => {
  it("drops todo/POC-* and todo/EXP-* rules from every stage", () => {
    const contracts = read("extensions/output-contract/contracts.json");
    expect(contracts).not.toContain("todo/POC-*.md");
    expect(contracts).not.toContain("todo/EXP-*.md");
    expect(contracts).not.toContain("poc.schema.yaml");
    expect(contracts).not.toContain("exp.schema.yaml");
  });

  it("blocks model writes to the platform-written dynamic.yaml in every stage", () => {
    const extension = read("extensions/output-contract/index.ts");
    expect(extension).toContain("PROTECTED_PATHS");
    expect(extension).toContain("\"dynamic.yaml\"");
  });
});

describe("bug-report skill + template contracts (B2)", () => {
  it("SKILL.md teaches awaiting-poc at creation and poc-verify advancement", () => {
    const skill = read("skills/bug-report/SKILL.md");
    expect(skill).toContain("awaiting-poc");
    expect(skill).not.toMatch(/pending 或 not-needed 二选一/);
    expect(skill).toMatch(/awaiting-poc[\s\S]{0,120}poc-verify|poc-verify[\s\S]{0,120}awaiting-poc/);
  });

  it("template.yaml initializes exp_status to awaiting-poc", () => {
    const template = read("skills/bug-report/template.yaml");
    expect(template).toMatch(/exp_status:\s*awaiting-poc/);
    expect(template).not.toMatch(/pending\|not-needed 二选一/);
  });
});

describe("agent + docs (HALL-35)", () => {
  it("agent.md teaches the engine-scheduled dynamic chain", () => {
    const agent = read("agents/agent.md");
    expect(agent).not.toContain("todo/POC-");
    expect(agent).not.toContain("todo/EXP-");
    expect(agent).toContain("dynamic.yaml");
  });

  it("flow.md documents the gate chain and the awaiting-poc state machine", () => {
    const flow = read("docs/flow-design/flow.md");
    expect(flow).not.toContain("todo/POC-");
    expect(flow).not.toContain("todo/EXP-");
    expect(flow).toContain("poc_gate");
    expect(flow).toContain("awaiting-poc");
  });

  it("README describes engine scheduling of poc-verify / ev-assess", () => {
    const readme = read("README.md");
    expect(readme).not.toContain("todo/POC-");
    expect(readme).not.toContain("todo/EXP-");
    expect(readme).toContain("dynamic.yaml");
  });
});
