import Ajv2020 from "ajv/dist/2020.js";
import decisionSchema from "../../schemas/prepare-semantic-decision-v2.schema.json" with {
  type: "json",
};
import {
  PREPARE_STAGES,
  SemanticDecisionValidationError,
  assembleAssessmentPlan as assembleV1,
  canonicalAssessmentPlanJson,
  canonicalSemanticDecisionJson,
  deriveAssessmentSummary,
  deriveTrustedWarnings,
  validateSemanticDecision as validateV1,
  type AssembleContext,
  type DecisionError,
  type PrepareStage,
} from "./semantic-decision.js";

export {
  canonicalAssessmentPlanJson,
  canonicalSemanticDecisionJson,
  SemanticDecisionValidationError,
};
export type { AssembleContext, DecisionError, PrepareStage };

type IssueSpec = {
  category: string;
  staticImpact: boolean;
  first: PrepareStage;
  expected: string;
  recommendations: [string, string][];
  dependency: null | { role: string; availability: string; integrity: string };
};
type UncertaintySpec = {
  code: string;
  description: string;
  recommendations: [string, string][];
  trustedTruncation?: boolean;
};
type ClaimSpec = {
  issues: string[];
  signal: string;
  observation: string;
  trustedTruncation?: boolean;
  count?: boolean;
};
const I: Record<string, IssueSpec> = {
  base_source_absent: {
    category: "base_source",
    staticImpact: true,
    first: "build",
    expected: "提交物引用“{subject}”，但未包含对应完整基础源码树。",
    recommendations: [
      ["include_base_source", "请补齐与当前提交物匹配的“{subject}”。"],
      [
        "submit_complete_project",
        "请重新提交同时包含基础源码与当前补丁、测试或覆盖内容的完整项目。",
      ],
    ],
    dependency: { role: "base_project_source", availability: "missing", integrity: "unknown" },
  },
  authoritative_first_party_input_absent: {
    category: "first_party_component",
    staticImpact: true,
    first: "build",
    expected: "已提交生成内容声明依赖“{subject}”，但权威第一方输入未包含在提交物中。",
    recommendations: [
      [
        "include_generated_sources_or_generator",
        "请补齐“{subject}”及其确定性生成定义，或提交由该权威输入生成且可审计的完整项目。",
      ],
      ["submit_complete_project", "请重新提交包含权威输入、生成链和项目源码的完整项目。"],
    ],
    dependency: { role: "first_party_component", availability: "missing", integrity: "unknown" },
  },
  generated_chain_incomplete: {
    category: "generated_source",
    staticImpact: true,
    first: "build",
    expected: "项目入口要求“{subject}”，但生成输出、输入或确定性生成定义未闭合。",
    recommendations: [
      [
        "include_generated_sources_or_generator",
        "请提交“{subject}”以及可复现它所需的输入、命令和工具声明。",
      ],
      ["submit_complete_project", "请重新提交生成链闭合的完整项目。"],
    ],
    dependency: null,
  },
  submodule_content_absent: {
    category: "submodule",
    staticImpact: true,
    first: "build",
    expected: "项目声明要求子模块“{subject}”，但其内容未包含在提交物中。",
    recommendations: [
      ["include_submodules", "请初始化并随提交物包含子模块“{subject}”的实际内容。"],
      ["submit_complete_project", "请重新提交包含全部必需子模块内容的完整项目。"],
    ],
    dependency: { role: "submodule", availability: "missing", integrity: "unknown" },
  },
  local_first_party_dependency_absent: {
    category: "dependency",
    staticImpact: true,
    first: "build",
    expected: "项目声明要求本地第一方依赖“{subject}”，但对应内容未包含在提交物中。",
    recommendations: [
      ["submit_complete_project", "请重新提交包含本地第一方依赖“{subject}”实际内容的完整项目。"],
    ],
    dependency: { role: "first_party_component", availability: "missing", integrity: "unknown" },
  },
  build_manifest_absent: {
    category: "build_manifest",
    staticImpact: false,
    first: "build",
    expected: "提交物缺少用于建立“{subject}”构建边界的必需构建定义。",
    recommendations: [
      ["include_build_files", "请补齐“{subject}”的项目或构建定义文件。"],
      ["submit_complete_project", "请重新提交包含完整构建入口的项目。"],
    ],
    dependency: null,
  },
  required_build_asset_absent: {
    category: "asset",
    staticImpact: false,
    first: "build",
    expected: "构建阶段要求资产“{subject}”，但实际资产内容未包含在提交物中。",
    recommendations: [
      ["provide_asset", "请补齐构建所需资产“{subject}”的实际内容。"],
      ["submit_complete_project", "请重新提交包含全部构建资产的完整项目。"],
    ],
    dependency: null,
  },
  required_runtime_asset_absent: {
    category: "asset",
    staticImpact: false,
    first: "poc",
    expected: "POC或EXP运行阶段要求资产“{subject}”，但实际资产内容未包含在提交物中。",
    recommendations: [
      ["provide_asset", "请补齐运行验证所需资产“{subject}”的实际内容。"],
      ["submit_complete_project", "请重新提交包含全部运行资产的完整项目。"],
    ],
    dependency: null,
  },
  required_build_configuration_absent: {
    category: "configuration",
    staticImpact: false,
    first: "build",
    expected: "构建阶段要求配置“{subject}”，但该配置未包含在提交物中。",
    recommendations: [
      ["provide_asset", "请补齐构建所需配置“{subject}”。"],
      ["submit_complete_project", "请重新提交包含必需构建配置的完整项目。"],
    ],
    dependency: null,
  },
  required_runtime_configuration_absent: {
    category: "configuration",
    staticImpact: false,
    first: "poc",
    expected: "POC或EXP运行阶段要求配置“{subject}”，但该配置未包含在提交物中。",
    recommendations: [
      ["provide_asset", "请补齐运行验证所需配置“{subject}”。"],
      ["submit_complete_project", "请重新提交包含必需运行配置的完整项目。"],
    ],
    dependency: null,
  },
};
const U: Record<string, UncertaintySpec> = {
  project_evidence_insufficient: {
    code: "insufficient_evidence",
    description: "现有提交物不足以建立完整项目边界，也不能确认一个命名的必需组件确实缺失。",
    recommendations: [
      ["clarify_scope", "请明确本次审计对象和项目根。"],
      ["include_build_files", "请补充能够建立项目边界的项目或构建定义。"],
      ["submit_complete_project", "请重新提交边界可验证的完整项目。"],
    ],
  },
  project_scope_ambiguous: {
    code: "ambiguous_scope",
    description: "存在多个可独立成立的项目根，但没有可信元数据声明它们的共同审计边界。",
    recommendations: [
      ["clarify_scope", "请明确本次审计根及各根之间的关系。"],
      ["separate_projects", "如果各根没有共同边界，请拆分为独立项目提交。"],
    ],
  },
  project_evidence_conflicting: {
    code: "conflicting_evidence",
    description: "关键项目证据对审计边界或必要组成给出相互冲突的结论。",
    recommendations: [
      ["clarify_scope", "请澄清相互冲突的项目边界或组成声明。"],
      ["submit_complete_project", "请重新提交边界声明一致的完整项目。"],
    ],
  },
  decisive_file_unreadable: {
    code: "unreadable_required_file",
    description: "建立项目边界所需的关键文件在受限读取边界内无法读取。",
    recommendations: [
      ["retry", "请确认关键文件可读取后重新提交。"],
      ["submit_complete_project", "请重新提交包含可读取关键定义的完整项目。"],
    ],
  },
  manifest_format_unsupported: {
    code: "unsupported_manifest",
    description: "关键项目清单格式当前不受Prepare语义检查支持。",
    recommendations: [
      ["contact_admin", "请联系管理员确认该项目清单格式的支持状态。"],
      ["retry", "在受支持的项目清单可用后重新提交。"],
    ],
  },
  manifest_truncation_blocks_closure: {
    code: "insufficient_evidence",
    description: "机械项目清单达到受信读取上限，现有证据不足以确认边界闭合。",
    recommendations: [["retry", "请在管理员调整部署读取上限或缩小提交范围后重新提交。"]],
    trustedTruncation: true,
  },
};
const Q: Record<
  string,
  { issues: string[]; all?: string[]; any?: string[]; expected: string; recommendation: string }
> = {
  base_identity_unresolved: {
    issues: ["base_source_absent"],
    all: ["base_identity_not_declared"],
    expected: "当前证据不能可靠定位匹配的基础版本或commit。",
    recommendation: "同时请明确与当前提交物匹配的版本或commit。",
  },
  overlay_set: {
    issues: ["base_source_absent"],
    any: [
      "patch_targets_unsubmitted_base",
      "installer_fetches_external_base",
      "build_requires_absent_base_tree",
    ],
    expected: "当前提交物是依赖外部基础树的补丁或覆盖集合。",
    recommendation: "请先把覆盖内容应用到匹配的基础树，再提交合并后的完整源码。",
  },
  lfs_pointer_only: {
    issues: ["required_build_asset_absent", "required_runtime_asset_absent"],
    all: ["asset_pointer_without_content"],
    expected: "提交物中的Git LFS指针不是所需资产内容。",
    recommendation: "Git LFS指针不能替代实际资产对象。",
  },
};
const C: Record<string, ClaimSpec> = {
  patch_submission_detected: {
    issues: ["base_source_absent"],
    signal: "source_tree_shape",
    observation: "提交物是补丁集合，不是完整基础源码树。",
  },
  patch_targets_unsubmitted_base: {
    issues: ["base_source_absent"],
    signal: "missing_reference",
    observation: "补丁引用“{subject}”中的路径，但对应基础源码未提交。",
  },
  external_base_declared: {
    issues: ["base_source_absent"],
    signal: "project_metadata",
    observation: "提交物声明需要外部基础项目“{subject}”。",
  },
  external_base_version_declared: {
    issues: ["base_source_absent"],
    signal: "project_metadata",
    observation: "提交物为外部基础项目“{subject}”声明了明确版本。",
  },
  base_identity_not_declared: {
    issues: ["base_source_absent"],
    signal: "missing_reference",
    observation: "提交物没有给出可可靠定位“{subject}”匹配版本或commit的标识。",
  },
  test_corpus_submission_detected: {
    issues: ["base_source_absent"],
    signal: "source_tree_shape",
    observation: "提交物是测试语料，不是被测项目的完整源码树。",
  },
  test_references_unsubmitted_base: {
    issues: ["base_source_absent"],
    signal: "missing_reference",
    observation: "测试入口引用“{subject}”的第一方源码，但该源码未提交。",
  },
  project_build_entrypoint_present: {
    issues: [
      "base_source_absent",
      "authoritative_first_party_input_absent",
      "generated_chain_incomplete",
      "submodule_content_absent",
      "local_first_party_dependency_absent",
      "required_build_asset_absent",
      "required_runtime_asset_absent",
      "required_build_configuration_absent",
      "required_runtime_configuration_absent",
    ],
    signal: "build_entrypoint",
    observation: "项目构建入口声明了当前缺失对象的使用位置。",
  },
  source_body_present: {
    issues: [
      "base_source_absent",
      "authoritative_first_party_input_absent",
      "generated_chain_incomplete",
      "submodule_content_absent",
      "local_first_party_dependency_absent",
    ],
    signal: "source_tree_shape",
    observation: "提交物包含可审计源码子集，但不足以闭合完整项目边界。",
  },
  generated_authoritative_input_declared_absent: {
    issues: ["authoritative_first_party_input_absent"],
    signal: "generated_source_reference",
    observation: "生成内容声明依赖权威第一方输入“{subject}”，但该输入未提交。",
  },
  generated_output_declared_absent: {
    issues: ["generated_chain_incomplete"],
    signal: "generated_source_reference",
    observation: "构建定义要求生成输出“{subject}”，但该输出未提交。",
  },
  generation_chain_not_submitted: {
    issues: ["generated_chain_incomplete"],
    signal: "missing_reference",
    observation: "生成“{subject}”所需的输入、命令或工具声明未形成闭合链。",
  },
  submodule_declared_without_content: {
    issues: ["submodule_content_absent"],
    signal: "submodule_reference",
    observation: "项目声明了子模块“{subject}”，但对应内容目录未提交。",
  },
  local_path_declared_absent: {
    issues: [
      "submodule_content_absent",
      "local_first_party_dependency_absent",
      "generated_chain_incomplete",
    ],
    signal: "missing_reference",
    observation: "项目入口引用本地对象“{subject}”，但对应路径不存在于提交物。",
  },
  local_first_party_dependency_declared: {
    issues: ["local_first_party_dependency_absent"],
    signal: "dependency_declaration",
    observation: "项目把“{subject}”声明为本地第一方依赖，而不是普通包坐标。",
  },
  build_manifest_not_submitted: {
    issues: ["build_manifest_absent"],
    signal: "missing_reference",
    observation: "现有项目说明要求“{subject}”的构建定义，但对应清单未提交。",
  },
  asset_required_by_project: {
    issues: ["required_build_asset_absent", "required_runtime_asset_absent"],
    signal: "asset_reference",
    observation: "项目声明构建或运行阶段需要资产“{subject}”。",
  },
  asset_pointer_without_content: {
    issues: ["required_build_asset_absent", "required_runtime_asset_absent"],
    signal: "asset_reference",
    observation: "提交物只包含“{subject}”的Git LFS指针，没有实际资产对象。",
  },
  configuration_required_by_project: {
    issues: ["required_build_configuration_absent", "required_runtime_configuration_absent"],
    signal: "missing_reference",
    observation: "项目声明构建或运行阶段需要配置“{subject}”。",
  },
  configuration_not_submitted: {
    issues: ["required_build_configuration_absent", "required_runtime_configuration_absent"],
    signal: "missing_reference",
    observation: "必需配置“{subject}”未包含在提交物中。",
  },
  isolated_source_body_present: {
    issues: ["project_evidence_insufficient"],
    signal: "source_tree_shape",
    observation: "提交物包含孤立源码片段，但没有足以建立项目闭包的入口。",
  },
  project_scope_not_established: {
    issues: ["project_evidence_insufficient"],
    signal: "documentation",
    observation: "现有说明不能建立可信审计边界或确认命名缺失项。",
  },
  complete_root_without_scope_relation: {
    issues: ["project_scope_ambiguous"],
    signal: "project_metadata",
    observation: "该路径具有独立项目入口，但没有元数据声明它与其他根的共同审计关系。",
  },
  project_evidence_conflicts: {
    issues: ["project_evidence_conflicting"],
    signal: "project_metadata",
    observation: "该项目证据与其他关键证据对审计边界的声明相冲突。",
  },
  decisive_file_unreadable: {
    issues: ["decisive_file_unreadable"],
    signal: "other",
    observation: "该关键文件在受限读取边界内无法读取。",
  },
  unsupported_manifest_detected: {
    issues: ["manifest_format_unsupported"],
    signal: "other",
    observation: "该关键项目清单使用当前不支持的格式。",
  },
  manifest_materially_truncated: {
    issues: ["manifest_truncation_blocks_closure"],
    signal: "other",
    observation: "机械项目清单达到受信读取上限，不能证明完整边界闭合。",
    trustedTruncation: true,
  },
  aggregate_test_corpus_detected: {
    issues: ["base_source_absent"],
    signal: "source_tree_shape",
    observation: "聚合清单描述{count}个测试用例根组成的测试语料。",
    count: true,
  },
  installer_fetches_external_base: {
    issues: ["base_source_absent"],
    signal: "missing_reference",
    observation: "安装脚本尝试下载外部基础项目“{subject}”，该下载声明不能替代提交源码。",
  },
  build_requires_absent_base_tree: {
    issues: ["base_source_absent"],
    signal: "missing_reference",
    observation: "构建入口要求“{subject}”的完整configure/build tree，但该基础树未提交。",
  },
};
const SIGNALS = [
  "project_metadata",
  "build_entrypoint",
  "dependency_declaration",
  "missing_reference",
  "source_tree_shape",
  "generated_source_reference",
  "submodule_reference",
  "container_definition",
  "full_system_indicator",
  "asset_reference",
  "documentation",
  "other",
];
const QUALIFIERS = ["base_identity_unresolved", "overlay_set", "lfs_pointer_only"];
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(decisionSchema);
const canonical = (v: any): any =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const cj = (v: any) => JSON.stringify(canonical(v));
const lex = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const render = (s: string, subject?: string, count?: number) =>
  s.replaceAll("{subject}", subject ?? "").replaceAll("{count}", String(count ?? ""));
const stageList = (first: PrepareStage, requested: readonly PrepareStage[]) =>
  PREPARE_STAGES.filter(
    (s) => requested.includes(s) && PREPARE_STAGES.indexOf(s) >= PREPARE_STAGES.indexOf(first),
  );
const err = (a: DecisionError[], p: string, m: string, k = "semantic") =>
  a.push({ instancePath: p, keyword: k, message: m });

function toV1Complete(d: any) {
  return {
    schema_version: "1.0",
    assessment: {
      status: "complete",
      submission_shape: d.submission_shape,
      intended_project: d.intended_project,
      root_candidates: d.root_candidates,
      confidence: d.confidence,
      static_visibility: "full",
      evidence: d.evidence,
      missing: [],
      uncertainties: [],
      external_dependencies: d.external_dependencies,
    },
    sandbox_requirements: d.sandbox_requirements,
  };
}
function semantic(decision: any, context: AssembleContext): DecisionError[] {
  const errors: DecisionError[] = [];
  const d = decision.decision;
  if (new TextEncoder().encode(cj(decision)).byteLength > 64 * 1024)
    err(errors, "", "canonical decision exceeds 64 KiB", "capacity");
  if (d.status === "complete") return [...errors, ...validateV1(toV1Complete(d), context)];
  d.root_candidates.forEach((p: string, i: number) => {
    if (!context.manifestPaths.has(p))
      err(errors, `/decision/root_candidates/${i}`, "path must be manifest-known");
  });
  const seenIssues = new Set<string>();
  d.issues.forEach((issue: any, i: number) => {
    const ip = `/decision/issues/${i}`;
    const key = cj({ ...issue, evidence: [...issue.evidence].map(canonical) });
    if (seenIssues.has(key)) err(errors, "/decision/issues", "normalized duplicate");
    seenIssues.add(key);
    const claims = new Set<string>();
    const seenEvidence = new Set<string>();
    issue.evidence.forEach((e: any, j: number) => {
      const ep = `${ip}/evidence/${j}`,
        spec = C[e.claim];
      if (!context.manifestPaths.has(e.path))
        err(errors, `${ep}/path`, "path must be manifest-known");
      if (e.path !== "." && !context.manifestFilePaths.has(e.path))
        err(errors, `${ep}/path`, "evidence path must be a manifest file");
      if (!spec?.issues.includes(issue.code))
        err(errors, `${ep}/claim`, "claim is incompatible with issue");
      if (spec?.trustedTruncation && (!context.manifestTruncated || e.path !== "."))
        err(errors, ep, "claim conflicts with trusted context");
      const ek = cj(e);
      if (seenEvidence.has(ek)) err(errors, `${ip}/evidence`, "normalized duplicate");
      seenEvidence.add(ek);
      claims.add(e.claim);
    });
    if (d.status === "incomplete") {
      const spec = I[issue.code];
      for (const [j, qc] of (issue.qualifiers ?? []).entries()) {
        const q = Q[qc];
        if (!q?.issues.includes(issue.code))
          err(errors, `${ip}/qualifiers/${j}`, "qualifier is incompatible with issue");
        if (q?.all?.some((x) => !claims.has(x)) || (q?.any && !q.any.some((x) => claims.has(x))))
          err(errors, `${ip}/qualifiers/${j}`, "qualifier evidence is missing");
      }
      const impact = [
        ...(spec.staticImpact && context.requestedStages.includes("static_audit")
          ? ["static_audit"]
          : []),
        ...stageList(spec.first, context.requestedStages).filter((x) => x !== "static_audit"),
      ];
      if (!impact.length) err(errors, ip, "issue is not relevant to requested stages");
    } else {
      const spec = U[issue.code];
      if (spec?.trustedTruncation && !context.manifestTruncated)
        err(errors, ip, "issue conflicts with trusted context");
    }
  });
  if (d.status === "incomplete") {
    const any = d.issues.some((x: any) => I[x.code].staticImpact);
    if (
      (any && !["partial", "none"].includes(d.source_visibility)) ||
      (!any && d.source_visibility !== "full")
    )
      err(errors, "/decision/source_visibility", "source visibility conflicts with issues");
  }
  return errors;
}
export function validateMinimalSemanticDecision(
  decision: unknown,
  context: AssembleContext,
): readonly DecisionError[] {
  const errors: DecisionError[] = [];
  if (!validateSchema(decision)) {
    for (const e of (validateSchema.errors ?? []).slice(0, 32))
      err(
        errors,
        String(e.instancePath ?? ""),
        String(e.message ?? "invalid").slice(0, 160),
        String(e.keyword ?? "schema"),
      );
    return errors;
  }
  errors.push(...semantic(decision as any, context));
  if (!errors.length) {
    try {
      const p = project(decision as any, context);
      if (p.recommendations?.length > 32)
        err(errors, "/decision/issues", "assembled recommendations exceed 32", "output_capacity");
      errors.push(...validateV1(validationV1(p.v1), context));
    } catch (e) {
      if (e instanceof SemanticDecisionValidationError) errors.push(...e.errors);
      else throw e;
    }
  }
  return errors.slice(0, 64);
}
function project(decision: any, context: AssembleContext) {
  const d = decision.decision;
  if (d.status === "complete") return { v1: toV1Complete(d), recommendations: null };
  const evidence: any[] = [];
  const missing: any[] = [];
  const uncertainties: any[] = [];
  const dependencies: any[] = [];
  const recommendations: any[] = [];
  const recSeen = new Set<string>();
  for (const issue of d.issues) {
    const paths = [...new Set(issue.evidence.map((x: any) => x.path))].sort();
    for (const e of issue.evidence) {
      const c = C[e.claim];
      evidence.push({
        path: e.path,
        signal: c.signal,
        observation: render(c.observation, issue.subject, e.count),
      });
    }
    if (d.status === "incomplete") {
      const s = I[issue.code],
        quals = QUALIFIERS.filter((q) => issue.qualifiers?.includes(q)),
        impact = [
          ...(s.staticImpact && context.requestedStages.includes("static_audit")
            ? ["static_audit"]
            : []),
          ...stageList(s.first, context.requestedStages).filter((x) => x !== "static_audit"),
        ];
      const suffix = quals.map((q) => Q[q].expected).join("");
      const recSuffix = quals.map((q) => Q[q].recommendation).join("");
      const recs = s.recommendations.map(
        ([code, message]) =>
          [code, `${render(message, issue.subject)}${recSuffix}`] as [string, string],
      );
      missing.push({
        category: s.category,
        name: issue.subject,
        required_by: `${render(s.expected, issue.subject)}${suffix}`,
        evidence_paths: paths,
        impact,
        recoverable_from_submission: false,
        recommendation_codes: recs.map((x) => x[0]),
        fix: recs.map((x) => x[1]).join(" "),
      });
      for (const [code, message] of recs) {
        const k = cj([code, message]);
        if (!recSeen.has(k)) {
          recSeen.add(k);
          recommendations.push({ code, message });
        }
      }
      if (s.dependency) {
        dependencies.push({
          name: issue.subject,
          role: s.dependency.role,
          availability: issue.evidence.some(
            (x: any) => x.claim === "installer_fetches_external_base",
          )
            ? "declared_download"
            : s.dependency.availability,
          integrity: s.dependency.integrity,
          required_for: impact,
          declared_by: paths,
          locator_hint: "",
        });
      }
    } else {
      const s = U[issue.code],
        description = `${s.description}${issue.subject ? `涉及“${issue.subject}”。` : ""}`;
      uncertainties.push({
        code: s.code,
        description,
        evidence_paths: paths,
        impact: [...context.requestedStages],
        recommendation_codes: s.recommendations.map((x) => x[0]),
        fix: s.recommendations.map((x) => x[1]).join(" "),
      });
      for (const [code, message] of s.recommendations) {
        const k = cj([code, message]);
        if (!recSeen.has(k)) {
          recSeen.add(k);
          recommendations.push({ code, message });
        }
      }
    }
  }
  evidence.sort(
    (a, b) =>
      lex(a.path, b.path) ||
      SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal) ||
      lex(a.observation, b.observation),
  );
  const dedupEvidence = evidence.filter((x, i) => !i || cj(x) !== cj(evidence[i - 1]));
  const assessment = {
    status: d.status,
    submission_shape: d.submission_shape,
    intended_project: d.intended_project,
    root_candidates: d.root_candidates,
    confidence: d.confidence,
    static_visibility: d.status === "uncertain" ? "unknown" : d.source_visibility,
    evidence: dedupEvidence,
    missing,
    uncertainties,
    external_dependencies: dependencies,
  };
  return { v1: { schema_version: "1.0", assessment, sandbox_requirements: null }, recommendations };
}
function validationV1(value: any) {
  const v = structuredClone(value),
    categories = new Set(v.assessment.missing.map((x: any) => x.category));
  v.assessment.external_dependencies = v.assessment.external_dependencies.map((x: any) =>
    x.role === "first_party_component" && !categories.has("first_party_component")
      ? { ...x, role: "other" }
      : x,
  );
  const generated = v.assessment.evidence.some(
    (x: any) => x.signal === "generated_source_reference",
  );
  if (!generated)
    for (const x of v.assessment.missing)
      if (x.category === "first_party_component")
        x.recommendation_codes = x.recommendation_codes.filter(
          (c: string) => c !== "include_generated_sources_or_generator",
        );
  return v;
}
function noncompletePlan(p: any, context: AssembleContext) {
  const a = p.v1.assessment,
    requested = new Set(context.requestedStages);
  const stageReadiness = Object.fromEntries(
    PREPARE_STAGES.map((stage) => {
      if (!requested.has(stage)) return [stage, { status: "not_requested", reasons: [] }];
      if (a.status === "uncertain")
        return [
          stage,
          {
            status: "unknown",
            reasons: ["项目边界或必要组成存在未消解的不确定性；详见 uncertainties。"],
          },
        ];
      const n = a.missing.filter((x: any) => x.impact.includes(stage)).length;
      if (!n) return [stage, { status: "ready", reasons: [] }];
      return [
        stage,
        {
          status:
            stage === "static_audit" && a.static_visibility === "partial" ? "limited" : "blocked",
          reasons: [`受 ${n} 项已确认缺失影响；详见 missing_components。`],
        },
      ];
    }),
  );
  const source = {
    status: a.status,
    submission_shape: a.submission_shape,
    intended_project: a.intended_project,
    root_candidates: [...a.root_candidates].sort(),
    missing_components: a.missing.map((x: any) => ({
      category: x.category,
      name: x.name,
      expected_by: x.required_by,
      evidence_paths: [...x.evidence_paths].sort(),
      impact: PREPARE_STAGES.filter((s) => x.impact.includes(s)),
      recoverable_from_submission: false,
    })),
    external_dependencies: a.external_dependencies.map((x: any) => ({
      ...x,
      required_for: PREPARE_STAGES.filter((s) => x.required_for.includes(s)),
      declared_by: [...x.declared_by].sort(),
    })),
    uncertainties: a.uncertainties.map((x: any) => ({
      code: x.code,
      description: x.description,
      evidence_paths: [...x.evidence_paths].sort(),
      impact: PREPARE_STAGES.filter((s) => x.impact.includes(s)),
    })),
    stage_readiness: stageReadiness,
    confidence: a.confidence,
    summary: deriveAssessmentSummary(a),
    evidence: a.evidence,
    user_recommendations: p.recommendations,
  };
  return canonical({
    schema_version: "1.0",
    source_assessment: source,
    sandbox_plan: null,
    warnings: deriveTrustedWarnings(a.external_dependencies, context.manifestTruncated),
  });
}
export function assembleMinimalSemanticDecision(decision: unknown, context: AssembleContext): any {
  if (!validateSchema(decision)) {
    throw new SemanticDecisionValidationError(validateMinimalSemanticDecision(decision, context));
  }
  const sem = semantic(decision as any, context);
  if (sem.length) throw new SemanticDecisionValidationError(sem);
  const p = project(decision as any, context);
  const errors = [
    ...(p.recommendations?.length > 32
      ? [
          {
            instancePath: "/decision/issues",
            keyword: "output_capacity",
            message: "assembled recommendations exceed 32",
          },
        ]
      : []),
    ...validateV1(validationV1(p.v1), context),
  ];
  if (errors.length) throw new SemanticDecisionValidationError(errors);
  if ((decision as any).decision.status === "complete") return canonical(assembleV1(p.v1, context));
  return noncompletePlan(p, context);
}
export function canonicalMinimalSemanticDecisionJson(decision: any): string {
  return cj(decision);
}
