import { createHash } from "node:crypto";
const STAGES = ["static_audit", "build", "poc", "exp"];
const ALLOWED_TOOLS = /* @__PURE__ */ new Set(["read_project_manifest", "read_project_file", "submit_plan"]);
const STONESOUP_ROOTS = [
  "148805-v1.0.0",
  "148806-v1.0.0",
  "148807-v1.0.0",
  "148808-v1.0.0",
  "148809-v1.0.0",
  "148811-v1.0.0",
  "148812-v1.0.0",
  "148813-v1.0.0",
  "148814-v1.0.0",
  "148815-v1.0.0",
  "148816-v1.0.0",
  "148817-v1.0.0",
  "148818-v1.0.0",
  "231334-v1.0.0",
  "231335-v1.0.0",
  "231336-v1.0.0",
  "231337-v1.0.0",
  "231337-v2.0.0",
  "231338-v1.0.0",
  "231338-v2.0.0"
].sort();
function values(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => values(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => values(item, out));
  return out;
}
function sortedUnique(items) {
  return [...new Set(items.filter((item) => typeof item === "string"))].sort();
}
function assertSetContains(actual, expected, label) {
  for (const item of Array.isArray(expected) ? expected : []) {
    if (!actual.includes(item)) throw new Error(`${label} missing ${item}`);
  }
}
function assertSetExcludes(actual, forbidden, label) {
  for (const item of Array.isArray(forbidden) ? forbidden : []) {
    if (actual.includes(item)) throw new Error(`${label} contains forbidden ${item}`);
  }
}
function conceptPresent(text, concept) {
  const lower = text.toLowerCase();
  if (concept === "base source absent") return /base.{0,40}(source|tree).{0,40}(absent|missing|not (?:included|present|submitted))/.test(lower) || /(absent|missing|not (?:included|present|submitted)).{0,40}base.{0,40}(source|tree)/.test(lower);
  if (concept === "base version not reliably locatable") return /(version.{0,60}(unknown|unreliable|cannot|unable|not).{0,30}(locat|identif))/.test(lower) || /(cannot|unable).{0,40}(locat|identify).{0,40}version/.test(lower);
  if (concept === "LFS pointer is not asset content") return /lfs.{0,60}pointer.{0,80}(not|missing|instead).{0,50}(asset|content|object)/.test(lower);
  return lower.includes(concept.toLowerCase());
}
function normalizePreparePlan(plan) {
  return {
    status: String(plan?.source_assessment?.status ?? ""),
    submission_shape: String(plan?.source_assessment?.submission_shape ?? ""),
    missing_categories: sortedUnique((plan?.source_assessment?.missing_components ?? []).map((item) => item?.category)),
    uncertainty_codes: sortedUnique((plan?.source_assessment?.uncertainties ?? []).map((item) => item?.code)),
    stage_status: Object.fromEntries(STAGES.map((stage) => [stage, String(plan?.source_assessment?.stage_readiness?.[stage]?.status ?? "")])),
    sandbox_plan: plan?.sandbox_plan == null ? "null" : "required",
    required_capabilities: sortedUnique(plan?.sandbox_plan?.requirements?.required_capabilities ?? [])
  };
}
function canonicalPlanDigest(planBytes) {
  return createHash("sha256").update(planBytes).digest("hex");
}
function assertPrepareSemanticOracle(plan, expected, options = {}) {
  const normalized = normalizePreparePlan(plan);
  if (normalized.status !== expected.status) throw new Error(`status expected ${expected.status}, got ${normalized.status}`);
  if (normalized.submission_shape !== expected.submission_shape) throw new Error(`submission_shape expected ${expected.submission_shape}, got ${normalized.submission_shape}`);
  if (JSON.stringify(normalized.missing_categories) !== JSON.stringify(sortedUnique(expected.missing_categories ?? []))) throw new Error("missing category set mismatch");
  if (JSON.stringify(normalized.uncertainty_codes) !== JSON.stringify(sortedUnique(expected.uncertainty_codes ?? []))) throw new Error("uncertainty code set mismatch");
  for (const stage of STAGES) {
    if (normalized.stage_status[stage] !== expected.stage_status?.[stage]) throw new Error(`${stage} readiness mismatch`);
  }
  const expectedSandbox = expected.sandbox_plan == null ? "null" : expected.sandbox_plan;
  if (normalized.sandbox_plan !== expectedSandbox) throw new Error("sandbox plan nullability mismatch");
  assertSetContains(normalized.required_capabilities, expected.required_capabilities_contains, "required capabilities");
  assertSetExcludes(normalized.required_capabilities, expected.required_capabilities_forbidden, "required capabilities");
  const catalog = new Set(options.capabilityCatalog ?? []);
  if (catalog.size > 0) assertSetExcludes(normalized.required_capabilities, normalized.required_capabilities.filter((item) => !catalog.has(item)), "required capabilities");
  const assessment = plan.source_assessment;
  const rootCandidates = sortedUnique(assessment.root_candidates ?? []);
  const evidencePaths = sortedUnique((assessment.evidence ?? []).map((item) => item?.path));
  const evidenceSignals = sortedUnique((assessment.evidence ?? []).map((item) => item?.signal));
  const recommendationCodes = sortedUnique((assessment.user_recommendations ?? []).map((item) => item?.code));
  const externalRoles = sortedUnique((assessment.external_dependencies ?? []).map((item) => item?.role));
  const warningCodes = sortedUnique((plan.warnings ?? []).map((item) => item?.code));
  assertSetContains(rootCandidates, expected.root_candidates_contains, "root candidates");
  assertSetContains(evidencePaths, expected.evidence_paths_contains, "evidence paths");
  assertSetExcludes(evidencePaths, expected.evidence_paths_forbidden, "evidence paths");
  assertSetContains(evidenceSignals, expected.evidence_signals_contains, "evidence signals");
  assertSetContains(recommendationCodes, expected.recommendation_codes_contains, "recommendation codes");
  assertSetContains(externalRoles, expected.external_dependency_roles_contains, "external dependency roles");
  assertSetContains(warningCodes, expected.warning_codes_contains, "warning codes");
  if (typeof expected.confidence_min === "number" && Number(assessment.confidence) < expected.confidence_min) throw new Error("confidence below oracle minimum");
  if (typeof expected.dependency_egress_required === "boolean" && plan.sandbox_plan?.requirements?.dependency_egress?.required !== expected.dependency_egress_required) {
    throw new Error("dependency egress mismatch");
  }
  const profile = plan.sandbox_plan?.profile_recommendation;
  if (profile && (profile.recommended_profile_id !== null || !Array.isArray(profile.alternative_profile_ids) || profile.alternative_profile_ids.length !== 0)) {
    throw new Error("profile recommendation must remain requirements-only");
  }
  if (expected.profile_recommendation) {
    if (profile?.recommended_profile_id !== expected.profile_recommendation.recommended_profile_id || JSON.stringify(profile?.alternative_profile_ids) !== JSON.stringify(expected.profile_recommendation.alternative_profile_ids)) throw new Error("profile recommendation mismatch");
  }
  const missingText = (assessment.missing_components ?? []).map((item) => `${item?.name ?? ""} ${item?.expected_by ?? ""}`).join(" ");
  for (const concept of expected.missing_names_must_convey ?? []) if (!conceptPresent(missingText, concept)) throw new Error(`missing component text does not convey: ${concept}`);
  const summaryText = `${assessment.summary ?? ""} ${(assessment.user_recommendations ?? []).map((item) => item?.message ?? "").join(" ")}`;
  for (const concept of expected.summary_must_convey ?? []) if (!conceptPresent(summaryText, concept)) throw new Error(`summary/recommendations do not convey: ${concept}`);
  const recommendationText = `${recommendationCodes.join(" ")} ${(assessment.user_recommendations ?? []).map((item) => item?.message ?? "").join(" ")}`.toLowerCase();
  const stonesoup = (expected.missing_names_must_convey ?? []).some((item) => String(item).includes("Asterisk 10.2.0"));
  if (stonesoup) {
    if (JSON.stringify(rootCandidates) !== JSON.stringify(STONESOUP_ROOTS)) throw new Error("Stonesoup must identify the exact 20 case roots");
    const semanticText = `${assessment.intended_project ?? ""} ${assessment.summary ?? ""} ${missingText}`.toLowerCase();
    if (!semanticText.includes("asterisk 10.2.0") || !semanticText.includes("20") || !/(test.{0,10}corpus|测试.{0,8}(语料|用例))/.test(semanticText)) {
      throw new Error("Stonesoup summary must identify the 20-root Asterisk 10.2.0 test corpus");
    }
    if (!/(overlay|覆盖|合并)/.test(recommendationText) || !/(complete|完整)/.test(recommendationText)) {
      throw new Error("Stonesoup recommendation must request the complete tree with overlays applied");
    }
    const observations = new Map((assessment.evidence ?? []).map((item) => [item.path, String(item.observation).toLowerCase()]));
    const requiredFacts = [
      ["manifest.sarif", /(20|aggregate|汇总|聚合)/],
      ["148805-v1.0.0/manifest.sarif", /asterisk.{0,20}10\.2\.0/],
      ["148805-v1.0.0/install-dependencies.sh", /(download|下载|获取).{0,40}(asterisk|base|基础)/],
      ["148805-v1.0.0/Makefile", /(configure|main\/asterisk|构建树)/]
    ];
    for (const [path, fact] of requiredFacts) if (!fact.test(observations.get(path) ?? "")) throw new Error(`Stonesoup evidence missing decisive fact: ${path}`);
  }
  for (const forbidden of expected.forbidden_recommendations ?? []) {
    const patterns = {
      download_base: /(?:prepare|platform|we|system).{0,30}(?:download|fetch).{0,30}(?:base|source)/,
      continue_build: /continue.{0,20}build/,
      continue_poc: /continue.{0,20}poc/,
      continue_exp: /continue.{0,20}exp/
    };
    if ((patterns[forbidden] ?? new RegExp(forbidden.replaceAll("_", ".*"))).test(recommendationText)) throw new Error(`forbidden recommendation: ${forbidden}`);
  }
  const allText = values(plan).join("\n");
  if (/(?:^|[^A-Za-z0-9])\/(?:home|root|workspace|work|opt|tmp)\//.test(allText)) throw new Error("absolute host/container path in plan");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]/i.test(allText)) throw new Error("credential/private key content in plan");
  for (const source of options.sourceTexts ?? []) {
    for (let index = 0; index + 64 <= source.length; index++) {
      if (allText.includes(source.slice(index, index + 64))) throw new Error("64-byte source excerpt copied into plan");
    }
  }
  for (const tool of options.toolCalls ?? []) if (!ALLOWED_TOOLS.has(tool)) throw new Error(`unauthorized tool call: ${tool}`);
  return normalized;
}
export {
  assertPrepareSemanticOracle,
  canonicalPlanDigest,
  normalizePreparePlan
};
