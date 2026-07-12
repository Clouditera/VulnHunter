import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { generateSourceManifest } from "../../src/features/prepare/source-manifest.js";
import { assertPrepareSemanticOracle, normalizePreparePlan } from "../support/prepare-semantic-oracle.mjs";

const repo = resolve(import.meta.dirname, "../../../..");
const fixtureRoot = join(repo, "packages/service/test/fixtures/prepare-semantic");
const oracle = loadYaml(readFileSync(join(fixtureRoot, "oracles-v1.yaml"), "utf8")) as any;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function canonicalPlan(expected: any): any {
  const missing = (expected.missing_categories ?? []).map((category: string, index: number) => ({
    category,
    name: expected.missing_names_must_convey?.join("; ") || `${category} required component`,
    expected_by: expected.missing_names_must_convey?.join("; ") || "declared project boundary",
    evidence_paths: expected.evidence_paths_contains?.slice(0, 1) ?? ["."],
    impact: ["static_audit", "build", "poc", "exp"],
    recoverable_from_submission: false,
  }));
  const uncertainties = (expected.uncertainty_codes ?? []).map((code: string) => ({
    code,
    description: "Two project-boundary interpretations cannot be distinguished from submitted metadata.",
    evidence_paths: expected.evidence_paths_contains?.slice(0, 1) ?? ["."],
  }));
  const evidencePaths = expected.evidence_paths_contains ?? ["."];
  const signals = expected.evidence_signals_contains ?? [];
  const plan: any = {
    schema_version: "1.0",
    source_assessment: {
      status: expected.status,
      submission_shape: expected.submission_shape,
      intended_project: "fixture project",
      root_candidates: expected.root_candidates_contains ?? ["."],
      missing_components: missing,
      external_dependencies: (expected.external_dependency_roles_contains ?? []).map((role: string) => ({ name: "dependency", role })),
      uncertainties,
      stage_readiness: Object.fromEntries(Object.entries(expected.stage_status).map(([stage, status]) => [stage, { status, reasons: status === "ready" || status === "not_requested" ? [] : ["fixture evidence"] }])),
      confidence: expected.confidence_min,
      summary: [...(expected.summary_must_convey ?? []), ...(expected.missing_names_must_convey ?? [])].join("; ") || "Project boundary assessment.",
      evidence: Array.from({ length: Math.max(evidencePaths.length, signals.length, 1) }, (_, index) => ({
        path: evidencePaths[index % evidencePaths.length] ?? ".",
        signal: signals[index] ?? signals[0] ?? "build_entrypoint",
        observation: "Short structural observation.",
      })),
      user_recommendations: (expected.recommendation_codes_contains ?? []).map((code: string) => ({ code, message: "Submit the complete declared project boundary." })),
    },
    sandbox_plan: expected.sandbox_plan == null || expected.sandbox_plan === "null" ? null : {
      requirements: {
        required_capabilities: expected.required_capabilities_contains ?? [],
        dependency_egress: { required: expected.dependency_egress_required ?? false },
      },
      profile_recommendation: { recommended_profile_id: null, alternative_profile_ids: [] },
    },
    warnings: (expected.warning_codes_contains ?? []).map((code: string) => ({ code, message: "Manifest evidence is truncated.", evidence_paths: ["."] })),
  };
  if ((expected.summary_must_convey ?? []).includes("LFS pointer is not asset content")) plan.source_assessment.summary = "The LFS pointer is not asset content.";
  if ((expected.summary_must_convey ?? []).includes("base source absent")) plan.source_assessment.summary = "The base source is absent and the base version cannot be reliably located.";
  return plan;
}

describe("M3-04 frozen prompts and one-way fixtures", () => {
  it("matches frozen prompt and oracle hashes and rejects fixture drift", () => {
    expect(sha256(readFileSync(join(repo, "flows/prepare/agents/prepare-agent.md")))).toBe("049ca71f365b63f5902a57efddc3146e4db6b4e9e69dd7bcf54423809fdeba9a");
    expect(sha256(readFileSync(join(repo, "flows/prepare/tasks/prepare.md")))).toBe("ef0132ed1fdd406dfbf50bd402801df471cadd3236cd98990b706e584ad71c56");
    expect(sha256(readFileSync(join(fixtureRoot, "oracles-v1.yaml")))).toBe("b0232e01569692a33ef0dafcdc4313fc06a1f674c9456dcad1a75c7edd991ffb");
    const checked = spawnSync("node", [join(repo, "scripts/generate-prepare-semantic-fixtures.mjs"), "--check"], { encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
    expect(oracle.fixtures).toHaveLength(15);
  });

  it("generates deterministic mechanical manifests for all 15 blueprints", () => {
    for (const fixture of oracle.fixtures) {
      const root = join(fixtureRoot, fixture.id);
      const options = { sourceKind: "directory" as const, limits: fixture.generator_options?.limits };
      const first = generateSourceManifest(root, options);
      const second = generateSourceManifest(root, options);
      expect(second).toEqual(first);
      expect(first.source.projection_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(first.tree.length).toBeGreaterThan(0);
      const known = new Set([".", ...first.tree.map((entry) => entry.path)]);
      for (const path of fixture.expected.evidence_paths_contains ?? []) expect(known.has(path), `${fixture.id}: ${path}`).toBe(true);
      for (const path of fixture.expected.root_candidates_contains ?? []) expect(first.root_candidates.map((root) => root.path)).toContain(path);
      expect(first.truncation.truncated).toBe(fixture.id === "uncertain_material_manifest_truncation");
    }
  });
});

describe("M3-04 normalized semantic oracle", () => {
  it("accepts every canonical normalized oracle and preserves stable fields", () => {
    for (const fixture of oracle.fixtures) {
      const plan = canonicalPlan(fixture.expected);
      const normalized = assertPrepareSemanticOracle(plan, fixture.expected, { capabilityCatalog: oracle.planner_input_defaults.capability_catalog.capabilities });
      expect(normalizePreparePlan(structuredClone(plan))).toEqual(normalized);
    }
  });

  it("enforces the external Stonesoup 20-root Asterisk test-corpus oracle", () => {
    const expected = oracle.external_fixtures[0].expected;
    const plan = canonicalPlan(expected);
    plan.source_assessment.root_candidates = [
      "148805-v1.0.0", "148806-v1.0.0", "148807-v1.0.0", "148808-v1.0.0", "148809-v1.0.0",
      "148811-v1.0.0", "148812-v1.0.0", "148813-v1.0.0", "148814-v1.0.0", "148815-v1.0.0",
      "148816-v1.0.0", "148817-v1.0.0", "148818-v1.0.0", "231334-v1.0.0", "231335-v1.0.0",
      "231336-v1.0.0", "231337-v1.0.0", "231337-v2.0.0", "231338-v1.0.0", "231338-v2.0.0",
    ];
    plan.source_assessment.intended_project = "Asterisk 10.2.0 test corpus";
    plan.source_assessment.summary = "This is a 20-root Asterisk 10.2.0 test corpus with the base source tree absent.";
    plan.source_assessment.user_recommendations.forEach((item: any) => { item.message = "Submit the complete Asterisk 10.2.0 tree with all overlays applied."; });
    const facts: Record<string, string> = {
      "manifest.sarif": "The aggregate manifest accompanies 20 case roots.",
      "148805-v1.0.0/manifest.sarif": "The case declares Asterisk 10.2.0.",
      "148805-v1.0.0/install-dependencies.sh": "The installer downloads the Asterisk base source.",
      "148805-v1.0.0/Makefile": "The build expects configure and main/asterisk.",
    };
    plan.source_assessment.evidence.forEach((item: any) => { item.observation = facts[item.path] ?? item.observation; });
    expect(() => assertPrepareSemanticOracle(plan, expected, { capabilityCatalog: oracle.planner_input_defaults.capability_catalog.capabilities })).not.toThrow();
    for (const message of [
      "Submit the complete Asterisk 10.2.0 tree with overlays, then ask the platform to download the base source.",
      "Submit the complete Asterisk 10.2.0 tree with overlays, then continue build.",
      "Submit the complete Asterisk 10.2.0 tree with overlays, then continue POC.",
      "Submit the complete Asterisk 10.2.0 tree with overlays, then continue EXP exploitation.",
      "提交完整 Asterisk 10.2.0 tree 并合并 overlays，然后由平台下载基础源码。",
      "提交完整 Asterisk 10.2.0 tree 并合并 overlays，然后继续构建。",
      "提交完整 Asterisk 10.2.0 tree 并合并 overlays，然后继续 POC。",
      "提交完整 Asterisk 10.2.0 tree 并合并 overlays，然后继续 EXP 利用。",
      "提交完整 Asterisk 10.2.0 tree 并合并 overlays；平台不得下载基础源码，然后继续构建、POC 和 EXP。",
    ]) {
      const unsafe = structuredClone(plan);
      unsafe.source_assessment.user_recommendations.forEach((item: any) => { item.message = message; });
      expect(() => assertPrepareSemanticOracle(unsafe, expected)).toThrow(/forbidden recommendation/);
    }
    const safelyNegated = structuredClone(plan);
    safelyNegated.source_assessment.user_recommendations.forEach((item: any) => {
      item.message = "请提交完整 Asterisk 10.2.0 tree 并合并 overlays；平台不得下载基础源码，不得继续构建，不得继续 POC，不得继续 EXP。";
    });
    expect(() => assertPrepareSemanticOracle(safelyNegated, expected)).not.toThrow();
    const ordinaryUse = structuredClone(plan);
    ordinaryUse.source_assessment.user_recommendations.forEach((item: any) => {
      item.message = "请提交完整 Asterisk 10.2.0 tree 并合并 overlays；仅可继续利用现有证据整理静态说明。";
    });
    expect(() => assertPrepareSemanticOracle(ordinaryUse, expected)).not.toThrow();
    plan.source_assessment.root_candidates.pop();
    expect(() => assertPrepareSemanticOracle(plan, expected)).toThrow(/exact 20 case roots/);
  });

  it("fails closed on status drift, invented capability, profile selection, tool escape, paths and excerpts", () => {
    const fixture = oracle.fixtures[0];
    const base = canonicalPlan(fixture.expected);
    const check = (mutate: (plan: any) => void, options: any = {}) => {
      const plan = structuredClone(base); mutate(plan);
      expect(() => assertPrepareSemanticOracle(plan, fixture.expected, { capabilityCatalog: oracle.planner_input_defaults.capability_catalog.capabilities, ...options })).toThrow();
    };
    check((plan) => { plan.source_assessment.status = "uncertain"; });
    check((plan) => { plan.sandbox_plan.requirements.required_capabilities.push("invented_root_vm"); });
    check((plan) => { plan.sandbox_plan.profile_recommendation.recommended_profile_id = "profile-secret"; });
    check(() => {}, { toolCalls: ["bash"] });
    for (const path of [
      "/source/project", "/control/private", "/output/plan", "/input/planner.json", "/workspace/src",
      "/work/tree", "/opt/app", "/tmp/file", "/home/user", "/root/key", "/etc/passwd", "/var/lib/data", "/run/secrets/key",
      "C:\\source\\project", "D:/input/planner.json",
    ]) check((plan) => { plan.source_assessment.summary = `internal path ${path}`; });
    const urlPlan = structuredClone(base);
    urlPlan.source_assessment.summary = "Public declarations: https://example.invalid/source/project and https://example.invalid/var/data";
    expect(() => assertPrepareSemanticOracle(urlPlan, fixture.expected, { capabilityCatalog: oracle.planner_input_defaults.capability_catalog.capabilities })).not.toThrow();
    const excerpt = "A".repeat(80);
    check((plan) => { plan.source_assessment.summary = excerpt; }, { sourceTexts: [excerpt] });
  });

  it("accepts equivalent Chinese completeness concepts", () => {
    const patch = oracle.fixtures.find((item: any) => item.id === "incomplete_patch_only_unlocated_base");
    const patchPlan = canonicalPlan(patch.expected);
    patchPlan.source_assessment.summary = "提交物缺少基础源码，并且基础源码版本无法可靠定位。";
    expect(() => assertPrepareSemanticOracle(patchPlan, patch.expected)).not.toThrow();

    const lfs = oracle.fixtures.find((item: any) => item.id === "incomplete_required_lfs_asset");
    const lfsPlan = canonicalPlan(lfs.expected);
    lfsPlan.source_assessment.summary = "LFS 指针不是实际资产内容。";
    expect(() => assertPrepareSemanticOracle(lfsPlan, lfs.expected)).not.toThrow();
  });
});
