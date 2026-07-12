import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  assembleAssessmentPlan, canonicalAssessmentPlanJson, SemanticDecisionValidationError, validateSemanticDecision,
  type AssembleContext,
} from "../../../../flows/prepare/extensions/prepare-tools/semantic-decision.js";
import { assertPrepareSemanticOracle } from "../support/prepare-semantic-oracle.mjs";
import { generateSourceManifest } from "../../src/features/prepare/source-manifest.js";
import { PrepareToolState } from "../../../../flows/prepare/extensions/prepare-tools/index.js";

const root = join(import.meta.dirname, "../../../..");
const oracle: any = parseYaml(readFileSync(join(root, "packages/service/test/fixtures/prepare-semantic/oracles-v1.yaml"), "utf8"));
const compactYaml = parseYaml(readFileSync(join(root, "flows/prepare/schemas/prepare-semantic-decision-v1.schema.yaml"), "utf8"));
const compactJson = JSON.parse(readFileSync(join(root, "flows/prepare/schemas/prepare-semantic-decision-v1.schema.json"), "utf8"));
const fullSchema = parseYaml(readFileSync(join(root, "flows/prepare/schemas/prepare-assessment-plan-v1.schema.yaml"), "utf8"));
const validateFull = new Ajv2020({ allErrors: true, strict: false }).compile(fullSchema);
const catalog = new Set(oracle.planner_input_defaults.capability_catalog.capabilities);
const requested = ["static_audit", "build", "poc", "exp"] as const;

function allPaths(files: string[], roots: string[] = ["."]) {
  const paths = new Set<string>([".", ...roots, ...files]);
  for (const file of files) {
    const parts = file.split("/");
    while (parts.length > 1) { parts.pop(); paths.add(parts.join("/")); }
  }
  return paths;
}
function context(files: string[], roots: string[] = ["."], truncated = false): AssembleContext {
  return { requestedStages: requested, capabilityCatalog: catalog, manifestPaths: allPaths(files, roots), manifestFilePaths: new Set(files), manifestRootCandidates: roots, manifestTruncated: truncated };
}
function expectedFiles(fixture: any): string[] { return Object.keys(fixture.source_blueprint.files); }
function decisionFor(fixture: any) {
  const e = fixture.expected;
  const files = expectedFiles(fixture);
  const roots = e.root_candidates_contains ?? ["."];
  const evidencePaths = [...new Set([...(e.evidence_paths_contains ?? []), files[0]])];
  const signals = e.evidence_signals_contains ?? [];
  const evidence = evidencePaths.map((path, index) => ({ path, signal: path === "." ? "other" : signals[index] ?? (index === 0 ? "project_metadata" : "source_tree_shape"), observation: `Bounded structural fact ${index + 1}.` }));
  if (e.status === "complete") {
    if (!evidence.some((item) => ["project_metadata", "build_entrypoint"].includes(item.signal))) evidence.push({ path: evidencePaths[0], signal: "project_metadata", observation: "Project metadata declares the boundary." });
    if (!evidence.some((item) => item.signal === "source_tree_shape")) evidence.push({ path: evidencePaths.at(-1)!, signal: "source_tree_shape", observation: "Source tree closes the declared boundary." });
  }
  const impacted = requested.filter((stage) => ["limited", "blocked"].includes(e.stage_status[stage]));
  const missing = (e.missing_categories ?? []).map((category: string, index: number) => {
    const codes = index === 0 ? (e.recommendation_codes_contains ?? ["submit_complete_project"]) : ["submit_complete_project"];
    const name = (e.missing_names_must_convey ?? []).join("; ") || `${category} required by declared project boundary`;
    if (category === "first_party_component" && codes.includes("include_generated_sources_or_generator")) evidence[0].signal = "generated_source_reference";
    const semanticFix = [...(e.summary_must_convey ?? []), "提交完整项目边界及声明的第一方内容。"].join("；");
    return { category, name, required_by: "Submitted declarations require this component.", evidence_paths: [evidencePaths[0]], impact: impacted, recoverable_from_submission: false, recommendation_codes: codes, fix: semanticFix };
  });
  const uncertaintyCode: Record<string, string> = { ambiguous_scope: "clarify_scope", conflicting_evidence: "clarify_scope", unreadable_required_file: "retry", unsupported_manifest: "contact_admin", insufficient_evidence: "clarify_scope", unknown: "clarify_scope" };
  const uncertainties = (e.uncertainty_codes ?? []).map((code: string) => ({ code, description: "Project boundary cannot be resolved from submitted evidence.", evidence_paths: [evidencePaths[0]], impact: [...requested], recommendation_codes: e.recommendation_codes_contains ?? [uncertaintyCode[code]], fix: "补充可核验的项目边界声明和必要组成。" }));
  const dependencies = (e.external_dependency_roles_contains ?? []).map((role: string) => ({ name: role, role, availability: "declared_download", integrity: "pinned", required_for: ["build"], declared_by: [evidencePaths[0]], locator_hint: "declared package coordinate" }));
  const visibility = e.status === "complete" ? "full" : e.status === "uncertain" ? "unknown" : e.stage_status.static_audit === "ready" ? "full" : e.stage_status.static_audit === "blocked" ? "none" : "partial";
  const sandbox = e.status !== "complete" ? null : {
    target: { project_types: ["source_project"], languages: ["mixed"], build_systems: ["declared"], architectures: ["x86_64"], os_families: ["linux"], target_classes: ["userspace"] },
    required_capabilities: [...new Set(["ssh", "shell", ...(e.required_capabilities_contains ?? [])])],
    execution: { full_system: false, nested_docker: false, qemu_guest: false }, required_assets: [],
    dependency_egress: { required: e.dependency_egress_required ?? false, reasons: e.dependency_egress_required ? ["Declared third-party package download is required."] : [] }, confidence: 0.9,
  };
  const truncated = (e.warning_codes_contains ?? []).includes("manifest_truncated");
  return { decision: { schema_version: "1.0", assessment: { status: e.status, submission_shape: e.submission_shape, intended_project: `fixture ${fixture.id}`, root_candidates: roots, confidence: Math.max(e.confidence_min ?? 0.8, 0.9), static_visibility: visibility, evidence, missing, uncertainties, external_dependencies: dependencies }, sandbox_requirements: sandbox }, context: context(files, roots, truncated) };
}

function stonesoup() {
  const roots = ["148805-v1.0.0","148806-v1.0.0","148807-v1.0.0","148808-v1.0.0","148809-v1.0.0","148811-v1.0.0","148812-v1.0.0","148813-v1.0.0","148814-v1.0.0","148815-v1.0.0","148816-v1.0.0","148817-v1.0.0","148818-v1.0.0","231334-v1.0.0","231335-v1.0.0","231336-v1.0.0","231337-v1.0.0","231337-v2.0.0","231338-v1.0.0","231338-v2.0.0"];
  const files = ["manifest.sarif","148805-v1.0.0/manifest.sarif","148805-v1.0.0/install-dependencies.sh","148805-v1.0.0/Makefile"];
  const evidence = [
    { path: files[0], signal: "source_tree_shape", observation: "Aggregate manifest records 20 test corpus roots." },
    { path: files[1], signal: "dependency_declaration", observation: "Case manifest declares Asterisk 10.2.0." },
    { path: files[2], signal: "missing_reference", observation: "Script downloads the unpinned Asterisk base source." },
    { path: files[3], signal: "build_entrypoint", observation: "Makefile expects configure and main/asterisk from the absent tree." },
  ];
  return { decision: { schema_version: "1.0", assessment: { status: "incomplete", submission_shape: "test_corpus", intended_project: "Asterisk 10.2.0 SARD/Stonesoup 20-root test corpus overlays", root_candidates: roots, confidence: 0.99, static_visibility: "partial", evidence, missing: [{ category: "base_source", name: "Asterisk 10.2.0 base source tree is absent", required_by: "SARIF, installer, and Makefile require the complete base source.", evidence_paths: files, impact: [...requested], recoverable_from_submission: false, recommendation_codes: ["include_base_source", "submit_complete_project"], fix: "提交已合并测试覆盖的完整 Asterisk 10.2.0 源码树。" }], uncertainties: [], external_dependencies: [{ name: "asterisk-v10.2.0", role: "base_project_source", availability: "declared_download", integrity: "unpinned", required_for: [...requested], declared_by: [files[1], files[2]], locator_hint: "declared Asterisk dependency archive" }] }, sandbox_requirements: null }, context: context(files, roots) };
}

function clone<T>(value: T): T { return structuredClone(value); }
function expectInvalid(decision: any, ctx: AssembleContext, path?: string) {
  const errors = validateSemanticDecision(decision, ctx);
  expect(errors.length).toBeGreaterThan(0);
  if (path) expect(errors.some((error) => error.instancePath.includes(path))).toBe(true);
  expect(() => assembleAssessmentPlan(decision, ctx)).toThrow(SemanticDecisionValidationError);
}

describe("Prepare compact semantic decision deterministic assembly", () => {
  it("keeps the checked-in YAML and pure-validator JSON schemas identical", () => expect(compactJson).toEqual(compactYaml));

  it("assembles all 15 generated semantic fixtures and Stonesoup into full-schema/oracle-valid plans", () => {
    const fixtures = oracle.fixtures.map(decisionFor);
    fixtures.push(stonesoup() as any);
    expect(fixtures).toHaveLength(16);
    fixtures.forEach(({ decision, context: ctx }: any, index: number) => {
      const plan = assembleAssessmentPlan(decision, ctx);
      expect(validateFull(plan), JSON.stringify(validateFull.errors)).toBe(true);
      const expected = index < oracle.fixtures.length ? oracle.fixtures[index].expected : {
        status: "incomplete", submission_shape: "test_corpus", missing_categories: ["base_source"], uncertainty_codes: [],
        stage_status: { static_audit: "limited", build: "blocked", poc: "blocked", exp: "blocked" }, sandbox_plan: "null",
        root_candidates_contains: decision.assessment.root_candidates, evidence_paths_contains: decision.assessment.evidence.map((item: any) => item.path),
        recommendation_codes_contains: ["include_base_source", "submit_complete_project"], external_dependency_roles_contains: ["base_project_source"],
        warning_codes_contains: ["unpinned_base_source_download"], missing_names_must_convey: ["Asterisk 10.2.0"],
      };
      expect(() => assertPrepareSemanticOracle(plan, expected, { capabilityCatalog: [...catalog] }), index < oracle.fixtures.length ? oracle.fixtures[index].id : "stonesoup").not.toThrow();
    });
  });

  it("passes the existing full-plan schema, semantic, atomic, and postflight gates", async () => {
    const temp = mkdtempSync(join(tmpdir(), "prepare-r1-full-gate-"));
    const source = join(temp, "source"), control = join(temp, "control"), output = join(temp, "output");
    mkdirSync(source); mkdirSync(control, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
    writeFileSync(join(source, "README.md"), "Complete source project.\n");
    writeFileSync(join(source, "CMakeLists.txt"), "project(example C)\n");
    const manifest = generateSourceManifest(source);
    const planner = { schema_version: "prepare-planner-input/v1", source_manifest: manifest, task_flags: { enable_poc: false, enable_exp: false, requested_stages: [] }, capability_catalog: { version: "v1", capabilities: ["ssh", "shell"] }, profile_recommendation_mode: "requirements_only" };
    const plannerInputPath = join(control, "planner.json"); writeFileSync(plannerInputPath, JSON.stringify(planner), { mode: 0o600 });
    const decision = { schema_version: "1.0", assessment: { status: "complete", submission_shape: "project", intended_project: "example", root_candidates: ["."], confidence: 0.95, static_visibility: "full", evidence: [{ path: "CMakeLists.txt", signal: "project_metadata", observation: "CMake declares the project." }, { path: "README.md", signal: "source_tree_shape", observation: "Submitted source boundary is present." }], missing: [], uncertainties: [], external_dependencies: [] }, sandbox_requirements: { target: { project_types: ["native"], languages: ["c"], build_systems: ["cmake"], architectures: ["x86_64"], os_families: ["linux"], target_classes: ["userspace"] }, required_capabilities: ["ssh", "shell"], execution: { full_system: false, nested_docker: false, qemu_guest: false }, dependency_egress: { required: false, reasons: [] }, confidence: 0.9 } };
    const ctx = context(["README.md", "CMakeLists.txt"]); ctx.requestedStages = ["static_audit"];
    const plan = assembleAssessmentPlan(decision, ctx);
    const state = new PrepareToolState({ sourceRoot: source, controlDir: control, outputDir: output, plannerInputPath, manifestSchemaPath: join(root, "packages/service/src/features/prepare/schemas/source-manifest-v1.schema.json"), planSchemaPath: join(root, "flows/prepare/schemas/prepare-assessment-plan-v1.schema.yaml") });
    try { const submitted = await state.submitPlan(plan); expect(state.postflight().plan_sha256).toBe(submitted.plan_sha256); }
    finally { state.close(); rmSync(temp, { recursive: true, force: true }); }
  });

  it("is byte-identical across 100 assemblies without mutating model-owned input", () => {
    const { decision, context: ctx } = decisionFor(oracle.fixtures[0]);
    const before = JSON.stringify(decision);
    const bytes = canonicalAssessmentPlanJson(assembleAssessmentPlan(decision, ctx));
    for (let i = 0; i < 100; i++) expect(canonicalAssessmentPlanJson(assembleAssessmentPlan(decision, ctx))).toBe(bytes);
    expect(JSON.stringify(decision)).toBe(before);
    const plan = JSON.parse(bytes);
    expect(plan.source_assessment.status).toBe(decision.assessment.status);
    expect(plan.source_assessment.evidence).toEqual(decision.assessment.evidence);
    expect(plan.sandbox_plan.requirements.required_capabilities.sort()).toEqual([...decision.sandbox_requirements.required_capabilities].sort());
  });

  it("derives only readiness/templates/profile defaults and preserves gap/dependency semantics", () => {
    const { decision, context: ctx } = decisionFor(oracle.fixtures[1]);
    const plan = assembleAssessmentPlan(decision, ctx);
    expect(plan.source_assessment.missing_components[0]).toMatchObject({ category: decision.assessment.missing[0].category, name: decision.assessment.missing[0].name, expected_by: decision.assessment.missing[0].required_by, recoverable_from_submission: false });
    expect(plan.source_assessment.user_recommendations[0]).toEqual({ code: "include_base_source", message: `请按以下方式处理：${decision.assessment.missing[0].fix}` });
    expect(plan.sandbox_plan).toBeNull();
  });

  it("rejects schema/version/unknown/status/visibility/truncation conflicts", () => {
    const base = decisionFor(oracle.fixtures[0]);
    for (const mutate of [
      (d: any) => { d.schema_version = "2.0"; }, (d: any) => { d.extra = true; },
      (d: any) => { d.assessment.missing = [{ bad: true }]; }, (d: any) => { d.assessment.static_visibility = "partial"; },
    ]) { const d = clone(base.decision); mutate(d); expectInvalid(d, base.context); }
    expectInvalid(base.decision, { ...base.context, manifestTruncated: true }, "status");
  });

  it("rejects unknown fields, sensitive text, provider tokens, JWTs, and internal paths", () => {
    const base = decisionFor(oracle.fixtures[1]);
    for (const value of ["api_key=not-allowed", "ghp_abcdefghijklmnop", "xoxb-abcdefghijklmnop", "eyJabcdefgh.abcdefghijk.abcdefghijk"]) {
      const secret = clone(base.decision); secret.assessment.missing[0].fix = value; expectInvalid(secret, base.context);
    }
    const internal = clone(base.decision); internal.assessment.intended_project = "/workspace/private"; expectInvalid(internal, base.context);
  });

  it("rejects unknown/escaping paths, evidence closure, line misuse, and normalized duplicates", () => {
    const base = decisionFor(oracle.fixtures[2]);
    const unknown = clone(base.decision); unknown.assessment.evidence[0].path = "unknown/file"; expectInvalid(unknown, base.context, "evidence");
    const escaped = clone(base.decision); escaped.assessment.root_candidates = ["../escape"]; expectInvalid(escaped, base.context);
    const closure = clone(base.decision); closure.assessment.missing[0].evidence_paths = ["tests/cases.json"]; expectInvalid(closure, base.context, "evidence_paths");
    const line = clone(base.decision); line.assessment.evidence[0].line_start = 4; expectInvalid(line, base.context, "evidence");
    const duplicate = clone(base.decision); duplicate.assessment.evidence.push({ ...clone(duplicate.assessment.evidence[0]), observation: ` ${duplicate.assessment.evidence[0].observation} ` }); expectInvalid(duplicate, base.context, "evidence");
  });

  it("allows root candidates but rejects dot evidence outside its trusted truncation namespace", () => {
    const complete = decisionFor(oracle.fixtures[0]);
    expect(complete.decision.assessment.root_candidates).toContain(".");
    expect(validateSemanticDecision(complete.decision, complete.context)).toEqual([]);
    const ordinary = clone(complete.decision); ordinary.assessment.evidence.push({ path: ".", signal: "other", observation: "Untrusted aggregate claim." });
    expectInvalid(ordinary, complete.context, "evidence");
    const fake = clone(complete.decision); fake.assessment.evidence = [{ path: ".", signal: "project_metadata", observation: "Claims complete metadata." }, { path: ".", signal: "source_tree_shape", observation: "Claims complete source." }];
    expectInvalid(fake, complete.context, "evidence");
    expect(() => validateSemanticDecision(complete.decision, { ...complete.context, manifestPaths: new Set(["CMakeLists.txt"]) })).toThrow("Invalid trusted Prepare assembly context");
    expect(() => validateSemanticDecision(complete.decision, { ...complete.context, manifestFilePaths: new Set([".", "CMakeLists.txt"]) })).toThrow("Invalid trusted Prepare assembly context");
  });

  it("allows insufficient-evidence retry only for trusted manifest truncation", () => {
    const fixture = oracle.fixtures.find((item: any) => item.id === "uncertain_material_manifest_truncation");
    const base = decisionFor(fixture);
    expect(validateSemanticDecision(base.decision, base.context)).toEqual([]);
    expectInvalid(base.decision, { ...base.context, manifestTruncated: false }, "recommendation_codes");
    const plan = assembleAssessmentPlan(base.decision, base.context);
    expect(plan.warnings[0].code).toBe("manifest_truncated");
    expect(plan.source_assessment.evidence.some((item: any) => item.path === "." && item.signal === "other" && item.line_start == null)).toBe(true);
  });

  it("rejects stage, dependency, egress, and recommendation conflicts", () => {
    const base = decisionFor(oracle.fixtures[1]);
    const limitedCtx = { ...base.context, requestedStages: ["static_audit"] as const };
    expectInvalid(base.decision, limitedCtx, "impact");
    const dep = clone(base.decision); dep.assessment.external_dependencies.push({ name: "core", role: "submodule", availability: "missing", integrity: "unknown", required_for: ["build"], declared_by: [dep.assessment.evidence[0].path], locator_hint: "local" }); expectInvalid(dep, base.context, "external_dependencies");
    const rec = clone(base.decision); rec.assessment.missing[0].recommendation_codes = ["provide_asset"]; expectInvalid(rec, base.context, "recommendation_codes");
    const complete = decisionFor(oracle.fixtures[9]); complete.decision.sandbox_requirements.dependency_egress.required = false; complete.decision.sandbox_requirements.dependency_egress.reasons = []; expectInvalid(complete.decision, complete.context, "dependency_egress");
  });

  it("rejects catalog/overlap/nested Docker/QEMU conflicts", () => {
    const base = decisionFor(oracle.fixtures[0]);
    const cases = [
      (d: any) => d.sandbox_requirements.required_capabilities.push("outside_catalog"),
      (d: any) => d.sandbox_requirements.optional_capabilities = ["ssh"],
      (d: any) => { d.sandbox_requirements.execution.nested_docker = true; },
      (d: any) => { d.sandbox_requirements.execution.qemu_guest = true; },
    ];
    for (const mutate of cases) { const d = clone(base.decision); mutate(d); expectInvalid(d, base.context, "sandbox_requirements"); }
  });

  it("rejects assembled recommendation overflow instead of truncating model semantics", () => {
    const base = decisionFor(oracle.fixtures[1]);
    const decision = clone(base.decision);
    decision.assessment.missing = Array.from({ length: 17 }, (_, index) => ({ ...clone(decision.assessment.missing[0]), name: `missing base ${index}`, recommendation_codes: ["include_base_source", "submit_complete_project"], fix: `提交完整基础源码 ${index}` }));
    expectInvalid(decision, base.context, "assessment");
  });

  it("preserves dependency and sandbox asset fields while applying only deterministic ordering", () => {
    const base = decisionFor(oracle.fixtures[0]);
    const decision = clone(base.decision);
    decision.assessment.external_dependencies = [{ name: "tool", role: "build_tool", availability: "present", integrity: "pinned", required_for: ["build", "static_audit"], declared_by: [decision.assessment.evidence[0].path], locator_hint: "local tool" }];
    decision.sandbox_requirements.execution = { full_system: true, nested_docker: false, qemu_guest: true };
    decision.sandbox_requirements.required_capabilities.push("qemu_system");
    decision.sandbox_requirements.required_assets = [{ asset_type: "guest_image", asset_id: "linux.guest", version_constraint: "1", architecture: "x86_64", os_family: "linux", reason: "Declared full-system target." }];
    const plan = assembleAssessmentPlan(decision, base.context);
    expect(plan.source_assessment.external_dependencies[0]).toEqual({ ...decision.assessment.external_dependencies[0], required_for: ["static_audit", "build"] });
    expect(plan.sandbox_plan.requirements.required_assets).toEqual(decision.sandbox_requirements.required_assets);
    expect(plan.sandbox_plan.requirements.requires_qemu_guest).toBe(true);
  });

  it("uses frozen warning texts and deterministic sorted evidence", () => {
    const { decision, context: ctx } = stonesoup();
    const plan = assembleAssessmentPlan(decision, ctx);
    expect(plan.warnings).toEqual([{ code: "unpinned_base_source_download", message: "基础项目源码需要外部下载且未声明固定完整性标识。", evidence_paths: ["148805-v1.0.0/install-dependencies.sh", "148805-v1.0.0/manifest.sarif"] }]);
    const ordinary = decisionFor(oracle.fixtures[9]);
    ordinary.decision.assessment.external_dependencies[0].integrity = "unpinned";
    expect(assembleAssessmentPlan(ordinary.decision, ordinary.context).warnings[0].message).toBe("外部依赖需要下载且未声明固定完整性标识。");
    const truncated = clone(ctx) as any; truncated.manifestTruncated = true;
    expect(assembleAssessmentPlan(decision, truncated).warnings[0]).toEqual({ code: "manifest_truncated", message: "项目机械清单达到读取上限，完整性判断仅依据已确认事实。", evidence_paths: ["."] });
  });

  it("keeps the module free of filesystem, environment, network, time, and randomness APIs", () => {
    const source = readFileSync(join(root, "flows/prepare/extensions/prepare-tools/semantic-decision.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|process\.env|fetch\(|Date\.|Math\.random|randomUUID|node:net|node:http/);
  });
});
