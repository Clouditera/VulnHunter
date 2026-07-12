import { createHash } from "node:crypto";
import { PrepareSemanticOracleError } from "./prepare-semantic-safe-receipt.mjs";
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
function fail(rule) { throw new PrepareSemanticOracleError(rule); }
function assertSetContains(actual, expected, rule) {
  for (const item of Array.isArray(expected) ? expected : []) if (!actual.includes(item)) fail(rule);
}
function assertSetExcludes(actual, forbidden, rule) {
  for (const item of Array.isArray(forbidden) ? forbidden : []) if (actual.includes(item)) fail(rule);
}
function conceptPresent(text, concept) {
  const lower = text.toLowerCase();
  if (concept === "base source absent") return /base.{0,40}(source|tree).{0,40}(absent|missing|not (?:included|present|submitted))/.test(lower) || /(absent|missing|not (?:included|present|submitted)).{0,40}base.{0,40}(source|tree)/.test(lower) || /(?:缺少|未包含|未提交|不存在).{0,20}(?:基础|基线).{0,8}(?:源码|源代码)/.test(text) || /(?:基础|基线).{0,8}(?:源码|源代码).{0,20}(?:缺少|未包含|未提交|不存在)/.test(text);
  if (concept === "base version not reliably locatable") return /(version.{0,60}(unknown|unreliable|cannot|unable|not).{0,30}(locat|identif))/.test(lower) || /(cannot|unable).{0,40}(locat|identify).{0,40}version/.test(lower) || /版本.{0,30}(?:无法|不能|不可).{0,15}(?:可靠)?(?:定位|识别|确定)/.test(text) || /(?:无法|不能|不可).{0,15}(?:可靠)?(?:定位|识别|确定).{0,20}版本/.test(text);
  if (concept === "LFS pointer is not asset content") return /lfs.{0,60}pointer.{0,80}(not|missing|instead).{0,50}(asset|content|object)/.test(lower) || /lfs.{0,40}指针.{0,40}(?:不是|并非|不等于|无法替代).{0,30}(?:资产|内容|对象|实际文件)/i.test(text);
  return lower.includes(concept.toLowerCase());
}
function isNegatedRecommendation(fragment) {
  return /(?:do\s+not|don't|must\s+not|should\s+not|never|cannot|can't|不会|不得|不要|不可|不能|不应|禁止)/i.test(fragment);
}
function hasPositiveForbiddenRecommendation(text, kind) {
  const patterns = {
    download_base: /(?:prepare|platform|system|平台|系统).{0,30}(?:download|fetch|下载|获取|拉取).{0,40}(?:base|source|基础源码|基础源代码|源码|源代码)/gi,
    continue_build: /(?:continue|继续|随后|然后).{0,20}(?:build|构建|编译)/gi,
    continue_poc: /(?:continue|继续|随后|然后).{0,20}(?:poc|概念验证)/gi,
    continue_exp: /(?:continue|继续|随后|然后).{0,20}(?:exp|exploit|漏洞利用|利用验证|攻击利用)/gi
  };
  const pattern = patterns[kind];
  if (!pattern) return new RegExp(kind.replaceAll("_", ".*"), "i").test(text);
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prior = text.slice(0, index);
    let boundary = -1;
    for (const separator of prior.matchAll(/[。！？!?；;，,\n]|(?<!\d)\.(?!\d)/g)) boundary = separator.index ?? boundary;
    const currentClause = text.slice(boundary + 1, index + match[0].length);
    if (!isNegatedRecommendation(currentClause)) return true;
  }
  return false;
}
function containsInternalAbsolutePath(text) {
  const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "");
  return /(?:^|[^A-Za-z0-9])\/(?:source|control|output|input|workspace|work|opt|tmp|home|root|etc|var|run)(?:\/|$)/.test(withoutUrls) || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s]*/.test(withoutUrls);
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
  if (normalized.status !== expected.status) fail("status");
  if (normalized.submission_shape !== expected.submission_shape) fail("submission_shape");
  if (JSON.stringify(normalized.missing_categories) !== JSON.stringify(sortedUnique(expected.missing_categories ?? []))) fail("missing_categories");
  if (JSON.stringify(normalized.uncertainty_codes) !== JSON.stringify(sortedUnique(expected.uncertainty_codes ?? []))) fail("uncertainty_codes");
  for (const stage of STAGES) if (normalized.stage_status[stage] !== expected.stage_status?.[stage]) fail(`stage_status_${stage}`);
  const expectedSandbox = expected.sandbox_plan == null ? "null" : expected.sandbox_plan;
  if (normalized.sandbox_plan !== expectedSandbox) fail("sandbox_nullability");
  assertSetContains(normalized.required_capabilities, expected.required_capabilities_contains, "required_capabilities");
  assertSetExcludes(normalized.required_capabilities, expected.required_capabilities_forbidden, "required_capabilities");
  const catalog = new Set(options.capabilityCatalog ?? []);
  if (catalog.size > 0) assertSetExcludes(normalized.required_capabilities, normalized.required_capabilities.filter((item) => !catalog.has(item)), "required_capabilities");
  const assessment = plan.source_assessment;
  const rootCandidates = sortedUnique(assessment.root_candidates ?? []);
  const evidencePaths = sortedUnique((assessment.evidence ?? []).map((item) => item?.path));
  const evidenceSignals = sortedUnique((assessment.evidence ?? []).map((item) => item?.signal));
  const recommendationCodes = sortedUnique((assessment.user_recommendations ?? []).map((item) => item?.code));
  const externalRoles = sortedUnique((assessment.external_dependencies ?? []).map((item) => item?.role));
  const warningCodes = sortedUnique((plan.warnings ?? []).map((item) => item?.code));
  assertSetContains(rootCandidates, expected.root_candidates_contains, "root_candidates");
  assertSetContains(evidencePaths, expected.evidence_paths_contains, "evidence_paths");
  assertSetExcludes(evidencePaths, expected.evidence_paths_forbidden, "evidence_paths");
  assertSetContains(evidenceSignals, expected.evidence_signals_contains, "evidence_signals");
  assertSetContains(recommendationCodes, expected.recommendation_codes_contains, "recommendation_codes");
  assertSetContains(externalRoles, expected.external_dependency_roles_contains, "external_dependency_roles");
  assertSetContains(warningCodes, expected.warning_codes_contains, "warning_codes");
  if (typeof expected.confidence_min === "number" && Number(assessment.confidence) < expected.confidence_min) fail("confidence");
  if (typeof expected.dependency_egress_required === "boolean" && plan.sandbox_plan?.requirements?.dependency_egress?.required !== expected.dependency_egress_required) fail("dependency_egress");
  const profile = plan.sandbox_plan?.profile_recommendation;
  if (profile && (profile.recommended_profile_id !== null || !Array.isArray(profile.alternative_profile_ids) || profile.alternative_profile_ids.length !== 0)) fail("profile_recommendation");
  if (expected.profile_recommendation) {
    if (profile?.recommended_profile_id !== expected.profile_recommendation.recommended_profile_id || JSON.stringify(profile?.alternative_profile_ids) !== JSON.stringify(expected.profile_recommendation.alternative_profile_ids)) fail("profile_recommendation");
  }
  const missingText = (assessment.missing_components ?? []).map((item) => `${item?.name ?? ""} ${item?.expected_by ?? ""}`).join(" ");
  for (const concept of expected.missing_names_must_convey ?? []) if (!conceptPresent(missingText, concept)) fail("missing_component_semantics");
  const summaryText = `${assessment.summary ?? ""} ${(assessment.user_recommendations ?? []).map((item) => item?.message ?? "").join(" ")}`;
  for (const concept of expected.summary_must_convey ?? []) if (!conceptPresent(summaryText, concept)) fail("summary_semantics");
  const recommendationText = `${recommendationCodes.join("\n")}\n${(assessment.user_recommendations ?? []).map((item) => item?.message ?? "").join("\n")}`.toLowerCase();
  const stonesoup = (expected.missing_names_must_convey ?? []).some((item) => String(item).includes("Asterisk 10.2.0"));
  if (stonesoup) {
    if (JSON.stringify(rootCandidates) !== JSON.stringify(STONESOUP_ROOTS)) fail("stonesoup_roots");
    const semanticText = `${assessment.intended_project ?? ""} ${assessment.summary ?? ""} ${missingText}`.toLowerCase();
    if (!semanticText.includes("asterisk 10.2.0") || !semanticText.includes("20") || !/(test.{0,10}corpus|测试.{0,8}(语料|用例))/.test(semanticText)) {
      fail("stonesoup_summary");
    }
    if (!/(overlay|覆盖|合并)/.test(recommendationText) || !/(complete|完整)/.test(recommendationText)) {
      fail("stonesoup_recommendation");
    }
    const observations = new Map((assessment.evidence ?? []).map((item) => [item.path, String(item.observation).toLowerCase()]));
    const requiredFacts = [
      ["manifest.sarif", /(20|aggregate|汇总|聚合)/],
      ["148805-v1.0.0/manifest.sarif", /asterisk.{0,20}10\.2\.0/],
      ["148805-v1.0.0/install-dependencies.sh", /(download|下载|获取).{0,40}(asterisk|base|基础)/],
      ["148805-v1.0.0/Makefile", /(configure|main\/asterisk|构建树)/]
    ];
    for (const [path, fact] of requiredFacts) if (!fact.test(observations.get(path) ?? "")) fail("stonesoup_evidence");
  }
  for (const forbidden of expected.forbidden_recommendations ?? []) {
    if (hasPositiveForbiddenRecommendation(recommendationText, forbidden)) fail("forbidden_recommendation");
  }
  const allText = values(plan).join("\n");
  if (containsInternalAbsolutePath(allText)) fail("internal_path");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]/i.test(allText)) fail("sensitive_content");
  for (const source of options.sourceTexts ?? []) {
    for (let index = 0; index + 64 <= source.length; index++) {
      if (allText.includes(source.slice(index, index + 64))) fail("source_excerpt");
    }
  }
  for (const tool of options.toolCalls ?? []) if (!ALLOWED_TOOLS.has(tool)) fail("unauthorized_tool");
  return normalized;
}
export {
  assertPrepareSemanticOracle,
  canonicalPlanDigest,
  normalizePreparePlan
};
