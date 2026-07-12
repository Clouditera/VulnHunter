import Ajv2020 from "ajv/dist/2020.js";
import decisionSchema from "../../schemas/prepare-semantic-decision-v1.schema.json" with { type: "json" };

export const PREPARE_STAGES = ["static_audit", "build", "poc", "exp"] as const;
export type PrepareStage = typeof PREPARE_STAGES[number];

export interface AssembleContext {
  requestedStages: readonly PrepareStage[];
  capabilityCatalog: ReadonlySet<string>;
  manifestPaths: ReadonlySet<string>;
  manifestFilePaths: ReadonlySet<string>;
  manifestRootCandidates: readonly string[];
  manifestTruncated: boolean;
}

export interface DecisionError {
  instancePath: string;
  keyword: string;
  message: string;
}

export class SemanticDecisionValidationError extends Error {
  constructor(public readonly errors: readonly DecisionError[]) {
    super("Invalid Prepare semantic decision");
    this.name = "SemanticDecisionValidationError";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(decisionSchema);
const FIRST_PARTY_ROLES = new Set(["base_project_source", "first_party_component", "submodule"]);
const ROLE_MISSING_CATEGORY: Record<string, string> = {
  base_project_source: "base_source", first_party_component: "first_party_component", submodule: "submodule",
};
const RECOMMENDATIONS: Record<string, ReadonlySet<string>> = {
  "missing/base_source": new Set(["include_base_source", "submit_complete_project"]),
  "missing/first_party_component": new Set(["submit_complete_project", "include_generated_sources_or_generator"]),
  "missing/submodule": new Set(["include_submodules", "submit_complete_project"]),
  "missing/generated_source": new Set(["include_generated_sources_or_generator", "submit_complete_project"]),
  "missing/build_manifest": new Set(["include_build_files", "submit_complete_project"]),
  "missing/dependency": new Set(["submit_complete_project", "contact_admin"]),
  "missing/asset": new Set(["provide_asset", "submit_complete_project"]),
  "missing/configuration": new Set(["submit_complete_project", "provide_asset"]),
  "missing/unknown": new Set(["clarify_scope", "other"]),
  "uncertainty/ambiguous_scope": new Set(["clarify_scope", "separate_projects"]),
  "uncertainty/conflicting_evidence": new Set(["clarify_scope", "submit_complete_project"]),
  "uncertainty/unreadable_required_file": new Set(["retry", "submit_complete_project"]),
  "uncertainty/unsupported_manifest": new Set(["contact_admin", "retry"]),
  "uncertainty/insufficient_evidence": new Set(["clarify_scope", "include_build_files", "submit_complete_project", "retry"]),
  "uncertainty/unknown": new Set(["clarify_scope", "other"]),
};
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /https?:\/\/(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i,
];
const INTERNAL_PATH = /(?:^|[^A-Za-z0-9])\/(?:source|control|output|input|workspace|work|opt|tmp|home|root|etc|var|run)(?:\/|$)|(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/;

function canonicalObject(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalObject(value[key])]));
  return value;
}
function canonicalJson(value: any): string { return JSON.stringify(canonicalObject(value)); }
function posix(values: readonly string[]): string[] { return [...values].sort(); }
function stages(values: readonly PrepareStage[]): PrepareStage[] { return PREPARE_STAGES.filter((stage) => values.includes(stage)); }
function push(errors: DecisionError[], path: string, message: string, keyword = "semantic") {
  errors.push({ instancePath: path, keyword, message });
}
function hasSensitiveOrInternal(value: unknown): boolean {
  if (typeof value === "string") return SECRET_PATTERNS.some((pattern) => pattern.test(value)) || INTERNAL_PATH.test(value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, ""));
  if (Array.isArray(value)) return value.some(hasSensitiveOrInternal);
  return !!value && typeof value === "object" && Object.values(value).some(hasSensitiveOrInternal);
}
function underRoot(path: string, root: string): boolean { return root === "." || path === root || path.startsWith(`${root}/`); }
function warning(code: string, message: string, evidence_paths: string[]) { return { code, message, evidence_paths: posix([...new Set(evidence_paths)]) }; }

function validateContext(context: AssembleContext): void {
  const requested = [...context.requestedStages];
  if (!new Set(["static_audit", "static_audit,build,poc", "static_audit,build,poc,exp"]).has(requested.join(","))
    || new Set(requested).size !== requested.length || requested.some((stage) => !PREPARE_STAGES.includes(stage))
    || !context.manifestPaths.has(".") || context.manifestFilePaths.has(".")) {
    throw new Error("Invalid trusted Prepare assembly context");
  }
}

export function validateSemanticDecision(decision: unknown, context: AssembleContext): readonly DecisionError[] {
  validateContext(context);
  const errors: DecisionError[] = [];
  if (!validateSchema(decision)) {
    for (const error of (validateSchema.errors ?? []).slice(0, 32)) push(errors, String(error.instancePath ?? ""), String(error.message ?? "invalid").slice(0, 160), String(error.keyword ?? "schema"));
    return errors;
  }
  const d: any = decision;
  if (new TextEncoder().encode(canonicalJson(d)).byteLength > 64 * 1024) push(errors, "", "canonical decision exceeds 64 KiB", "capacity");
  if (hasSensitiveOrInternal(d)) push(errors, "", "decision contains sensitive or internal-path content");
  const assessment = d.assessment;
  const requested = new Set(context.requestedStages);
  const globalEvidence = new Map<string, any[]>();
  for (const [index, evidence] of assessment.evidence.entries()) {
    if (!context.manifestPaths.has(evidence.path)) push(errors, `/assessment/evidence/${index}/path`, "path must be manifest-known");
    if (evidence.path === "." && (!context.manifestTruncated || evidence.signal !== "other")) push(errors, `/assessment/evidence/${index}`, "root evidence is allowed only for trusted truncation with signal other");
    if ((evidence.line_start == null) !== (evidence.line_end == null)) push(errors, `/assessment/evidence/${index}`, "line range must include both endpoints");
    if (evidence.line_start != null && (!context.manifestFilePaths.has(evidence.path) || evidence.line_end < evidence.line_start)) push(errors, `/assessment/evidence/${index}`, "line range must reference a file and be ordered");
    globalEvidence.set(evidence.path, [...(globalEvidence.get(evidence.path) ?? []), evidence]);
  }
  const known = (path: string, pointer: string, mustBeEvidence = false) => {
    if (!context.manifestPaths.has(path)) push(errors, pointer, "path must be manifest-known");
    if (mustBeEvidence && !globalEvidence.has(path)) push(errors, pointer, "path must also appear in assessment evidence");
  };
  assessment.root_candidates.forEach((path: string, index: number) => known(path, `/assessment/root_candidates/${index}`));
  const checkImpact = (impact: PrepareStage[], pointer: string) => impact.forEach((stage, index) => { if (!requested.has(stage)) push(errors, `${pointer}/${index}`, "stage was not requested"); });
  assessment.missing.forEach((item: any, index: number) => {
    item.evidence_paths.forEach((path: string, p: number) => known(path, `/assessment/missing/${index}/evidence_paths/${p}`, true));
    checkImpact(item.impact, `/assessment/missing/${index}/impact`);
    const allowed = RECOMMENDATIONS[`missing/${item.category}`]!;
    item.recommendation_codes.forEach((code: string, p: number) => { if (!allowed.has(code)) push(errors, `/assessment/missing/${index}/recommendation_codes/${p}`, "recommendation is incompatible with missing category"); });
    if (item.category === "first_party_component" && item.recommendation_codes.includes("include_generated_sources_or_generator")
      && !item.evidence_paths.some((path: string) => (globalEvidence.get(path) ?? []).some((e) => e.signal === "generated_source_reference"))) {
      push(errors, `/assessment/missing/${index}/recommendation_codes`, "generated-source recommendation requires generated provenance evidence");
    }
  });
  assessment.uncertainties.forEach((item: any, index: number) => {
    item.evidence_paths.forEach((path: string, p: number) => known(path, `/assessment/uncertainties/${index}/evidence_paths/${p}`, true));
    checkImpact(item.impact, `/assessment/uncertainties/${index}/impact`);
    const allowed = RECOMMENDATIONS[`uncertainty/${item.code}`]!;
    item.recommendation_codes.forEach((code: string, p: number) => {
      if (!allowed.has(code) || (item.code === "insufficient_evidence" && code === "retry" && !context.manifestTruncated)) {
        push(errors, `/assessment/uncertainties/${index}/recommendation_codes/${p}`, "recommendation is incompatible with uncertainty code or trusted context");
      }
    });
  });
  assessment.external_dependencies.forEach((dependency: any, index: number) => {
    dependency.declared_by.forEach((path: string, p: number) => known(path, `/assessment/external_dependencies/${index}/declared_by/${p}`, true));
    checkImpact(dependency.required_for, `/assessment/external_dependencies/${index}/required_for`);
    if (/[?#]|:\/\/[^/\s]+@/.test(dependency.locator_hint)) push(errors, `/assessment/external_dependencies/${index}/locator_hint`, "locator hint cannot contain credentials, query, or fragment");
  });
  const arrays: Array<[any[], string]> = [];
  const collectArrays = (value: any, pointer = "") => {
    if (Array.isArray(value)) { arrays.push([value, pointer]); value.forEach((item, index) => collectArrays(item, `${pointer}/${index}`)); }
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => collectArrays(child, `${pointer}/${key}`));
  };
  collectArrays(d);
  const trimStrings = (value: any): any => typeof value === "string" ? value.trim() : Array.isArray(value) ? value.map(trimStrings) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, trimStrings(child)])) : value;
  const normalizedDuplicateKey = (value: any): string => canonicalJson(trimStrings(value));
  for (const [values, pointer] of arrays) if (new Set(values.map(normalizedDuplicateKey)).size !== values.length) push(errors, pointer || "/", "normalized duplicate");

  if (assessment.status === "complete") {
    if (context.manifestTruncated) push(errors, "/assessment/status", "complete conflicts with material manifest truncation");
    for (const root of assessment.root_candidates) if (!assessment.evidence.some((e: any) => underRoot(e.path, root))) push(errors, "/assessment/root_candidates", "each complete root requires boundary evidence");
    if (!assessment.evidence.some((e: any) => ["project_metadata", "build_entrypoint"].includes(e.signal))) push(errors, "/assessment/evidence", "complete requires project metadata or build entrypoint evidence");
    if (!assessment.evidence.some((e: any) => e.signal === "source_tree_shape")) push(errors, "/assessment/evidence", "complete requires source tree shape evidence");
  } else if (assessment.status === "incomplete") {
    const staticImpacted = assessment.missing.some((item: any) => item.impact.includes("static_audit"));
    if (assessment.static_visibility === "full" && staticImpacted) push(errors, "/assessment/static_visibility", "full visibility conflicts with static-audit missing impact");
    if (["partial", "none"].includes(assessment.static_visibility) && !staticImpacted) push(errors, "/assessment/static_visibility", "partial or none visibility requires static-audit missing impact");
  }

  const missingCategories = new Set(assessment.missing.map((item: any) => item.category));
  for (const [index, dependency] of assessment.external_dependencies.entries()) {
    if (FIRST_PARTY_ROLES.has(dependency.role) && ["missing", "declared_download", "unknown"].includes(dependency.availability)) {
      if (assessment.status === "complete") push(errors, `/assessment/external_dependencies/${index}`, "complete cannot miss first-party source");
      else if (["missing", "declared_download"].includes(dependency.availability) && !missingCategories.has(ROLE_MISSING_CATEGORY[dependency.role])) push(errors, `/assessment/external_dependencies/${index}`, "first-party dependency requires matching missing component");
    }
  }

  const sandbox = d.sandbox_requirements;
  if (sandbox) {
    const required = sandbox.required_capabilities as string[];
    const optional = (sandbox.optional_capabilities ?? []) as string[];
    if (!required.includes("ssh") || !required.includes("shell")) push(errors, "/sandbox_requirements/required_capabilities", "required capabilities must include ssh and shell");
    for (const [index, capability] of [...required, ...optional].entries()) if (!context.capabilityCatalog.has(capability)) push(errors, `/sandbox_requirements/capabilities/${index}`, "capability is outside trusted catalog");
    if (required.some((capability) => optional.includes(capability))) push(errors, "/sandbox_requirements", "required and optional capabilities overlap");
    if (sandbox.execution.nested_docker && !required.includes("docker")) push(errors, "/sandbox_requirements/execution/nested_docker", "nested Docker requires docker capability");
    if (sandbox.execution.qemu_guest && (!sandbox.execution.full_system || !required.includes("qemu_system") || !(sandbox.required_assets?.length > 0))) push(errors, "/sandbox_requirements/execution/qemu_guest", "QEMU guest requires full system, qemu_system, and an asset");
    const ordinaryDownload = assessment.external_dependencies.some((dependency: any) => !FIRST_PARTY_ROLES.has(dependency.role) && dependency.availability === "declared_download");
    if (ordinaryDownload && !sandbox.dependency_egress.required) push(errors, "/sandbox_requirements/dependency_egress", "declared dependency download requires egress");
  }

  const pairs = new Set<string>();
  let recommendations = 0;
  for (const gap of [...assessment.missing, ...assessment.uncertainties]) for (const code of gap.recommendation_codes) {
    const pair = canonicalJson([code, gap.fix]);
    if (!pairs.has(pair)) { pairs.add(pair); recommendations++; }
  }
  if (recommendations > 32) push(errors, "/assessment", "assembled recommendations exceed 32", "capacity");
  return errors.slice(0, 64);
}

function readiness(assessment: any, requestedStages: readonly PrepareStage[]) {
  const requested = new Set(requestedStages);
  return Object.fromEntries(PREPARE_STAGES.map((stage) => {
    if (!requested.has(stage)) return [stage, { status: "not_requested", reasons: [] }];
    if (assessment.status === "complete") return [stage, { status: "ready", reasons: [] }];
    if (assessment.status === "uncertain") return [stage, { status: "unknown", reasons: ["项目边界或必要组成存在未消解的不确定性；详见 uncertainties。"] }];
    const count = assessment.missing.filter((item: any) => item.impact.includes(stage)).length;
    if (!count) return [stage, { status: "ready", reasons: [] }];
    const status = stage === "static_audit" && assessment.static_visibility === "partial" ? "limited" : "blocked";
    return [stage, { status, reasons: [`受 ${count} 项已确认缺失影响；详见 missing_components。`] }];
  }));
}

function assembleRecommendations(assessment: any) {
  const seen = new Set<string>();
  const result: Array<{ code: string; message: string }> = [];
  for (const gap of [...assessment.missing, ...assessment.uncertainties]) for (const code of gap.recommendation_codes) {
    const key = canonicalJson([code, gap.fix]);
    if (!seen.has(key)) { seen.add(key); result.push({ code, message: `请按以下方式处理：${gap.fix}` }); }
  }
  return result;
}

function assembleWarnings(decision: any, context: AssembleContext) {
  const dependencies = decision.assessment.external_dependencies;
  const result: any[] = [];
  if (context.manifestTruncated) result.push(warning("manifest_truncated", "项目机械清单达到读取上限，完整性判断仅依据已确认事实。", ["."]));
  const base = dependencies.filter((item: any) => item.role === "base_project_source" && item.availability === "declared_download" && item.integrity === "unpinned");
  if (base.length) result.push(warning("unpinned_base_source_download", "基础项目源码需要外部下载且未声明固定完整性标识。", base.flatMap((item: any) => item.declared_by)));
  const ordinary = dependencies.filter((item: any) => !FIRST_PARTY_ROLES.has(item.role) && item.availability === "declared_download" && item.integrity === "unpinned");
  if (ordinary.length) result.push(warning("unpinned_dependency", "外部依赖需要下载且未声明固定完整性标识。", ordinary.flatMap((item: any) => item.declared_by)));
  return result;
}

export function assembleAssessmentPlan(decision: unknown, context: AssembleContext): any {
  const errors = validateSemanticDecision(decision, context);
  if (errors.length) throw new SemanticDecisionValidationError(errors);
  const d: any = decision;
  const assessment = d.assessment;
  const summaries: Record<string, string> = {
    complete: `已确认提交物中“${assessment.intended_project}”的审计边界及请求阶段前提闭合。`,
    incomplete: `已确认“${assessment.intended_project}”缺少本次请求所需的项目组成；详见缺失项与补齐建议。`,
    uncertain: `当前证据不足以确认“${assessment.intended_project}”的审计边界或请求阶段前提；详见不确定项与补充建议。`,
  };
  const source = {
    status: assessment.status,
    submission_shape: assessment.submission_shape,
    intended_project: assessment.intended_project,
    root_candidates: posix(assessment.root_candidates),
    missing_components: assessment.missing.map((item: any) => ({
      category: item.category, name: item.name, expected_by: item.required_by, evidence_paths: posix(item.evidence_paths),
      impact: stages(item.impact), recoverable_from_submission: item.recoverable_from_submission,
    })),
    external_dependencies: assessment.external_dependencies.map((item: any) => ({
      name: item.name, role: item.role, availability: item.availability, integrity: item.integrity,
      required_for: stages(item.required_for), declared_by: posix(item.declared_by), locator_hint: item.locator_hint,
    })),
    uncertainties: assessment.uncertainties.map((item: any) => ({
      code: item.code, description: item.description, evidence_paths: posix(item.evidence_paths), impact: stages(item.impact),
    })),
    stage_readiness: readiness(assessment, context.requestedStages),
    confidence: assessment.confidence,
    summary: summaries[assessment.status],
    evidence: assessment.evidence.map((item: any) => ({
      path: item.path, ...(item.line_start == null ? {} : { line_start: item.line_start, line_end: item.line_end }),
      signal: item.signal, observation: item.observation,
    })),
    user_recommendations: assembleRecommendations(assessment),
  };
  const sandbox = d.sandbox_requirements == null ? null : {
    target: Object.fromEntries(Object.entries(d.sandbox_requirements.target).map(([key, value]) => [key, posix(value as string[])])),
    requirements: {
      required_capabilities: posix(d.sandbox_requirements.required_capabilities),
      optional_capabilities: posix(d.sandbox_requirements.optional_capabilities ?? []),
      requires_full_system: d.sandbox_requirements.execution.full_system,
      requires_nested_docker: d.sandbox_requirements.execution.nested_docker,
      requires_qemu_guest: d.sandbox_requirements.execution.qemu_guest,
      required_assets: (d.sandbox_requirements.required_assets ?? []).map((item: any) => ({ ...item })),
      dependency_egress: { required: d.sandbox_requirements.dependency_egress.required, reasons: [...d.sandbox_requirements.dependency_egress.reasons] },
    },
    profile_recommendation: {
      recommended_profile_id: null, alternative_profile_ids: [], confidence: 0,
      reason: "当前阶段仅生成能力需求，Profile 选择由平台后续解析。",
    },
    confidence: d.sandbox_requirements.confidence,
    reason: "基于已确认完整的提交边界生成受管沙箱能力需求。",
  };
  return canonicalObject({ schema_version: "1.0", source_assessment: source, sandbox_plan: sandbox, warnings: assembleWarnings(d, context) });
}

export function canonicalAssessmentPlanJson(plan: Json): string { return `${canonicalJson(plan)}\n`; }
