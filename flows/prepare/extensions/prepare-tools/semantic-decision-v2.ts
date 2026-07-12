import Ajv2020 from "ajv/dist/2020.js";
import catalog from "../../schemas/prepare-minimal-semantic-catalog-v2.json" with { type: "json" };
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
  dependency: null | {
    role: string;
    availability: string;
    availabilityIfClaim: Record<string, string>;
    integrity: string;
    locatorHint: string;
  };
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
  exactPath?: string;
  count?: boolean;
};

// The frozen JSON mirror is the runtime policy authority. The focused tests require
// it to deep-equal the approved YAML bytes before any projection behavior is tested.
const I: Record<string, IssueSpec> = Object.fromEntries(
  Object.entries(catalog.incomplete_issue_catalog).map(([code, spec]) => [
    code,
    {
      category: spec.full_category,
      staticImpact: spec.static_impact,
      first: spec.first_hard_block_stage as PrepareStage,
      expected: spec.expected_by_template,
      recommendations: spec.recommendations.map(
        (item) => [item.code, item.message_template] as [string, string],
      ),
      dependency: spec.external_dependency
        ? {
            role: spec.external_dependency.role,
            availability: spec.external_dependency.availability_default,
            availabilityIfClaim:
              "availability_if_claim" in spec.external_dependency
                ? spec.external_dependency.availability_if_claim
                : {},
            integrity: spec.external_dependency.integrity,
            locatorHint: spec.external_dependency.locator_hint,
          }
        : null,
    },
  ]),
);
const U: Record<string, UncertaintySpec> = Object.fromEntries(
  Object.entries(catalog.uncertainty_issue_catalog).map(([code, spec]) => [
    code,
    {
      code: spec.full_code,
      description: spec.description_template,
      recommendations: spec.recommendations.map(
        (item) => [item.code, item.message_template] as [string, string],
      ),
      trustedTruncation: spec.trusted_requirements?.manifest_truncated,
    },
  ]),
);
const Q: Record<
  string,
  { issues: string[]; all?: string[]; any?: string[]; expected: string; recommendation: string }
> = Object.fromEntries(
  Object.entries(catalog.qualifier_catalog).map(([code, spec]) => [
    code,
    {
      issues: spec.allowed_issue_codes,
      all: "requires_all_claims" in spec ? spec.requires_all_claims : undefined,
      any: "requires_any_claims" in spec ? spec.requires_any_claims : undefined,
      expected: spec.expected_by_suffix,
      recommendation: spec.recommendation_suffix,
    },
  ]),
);
const C: Record<string, ClaimSpec> = Object.fromEntries(
  Object.entries(catalog.claim_catalog).map(([code, spec]) => [
    code,
    {
      issues: spec.allowed_issues,
      signal: spec.signal,
      observation: spec.observation_template,
      trustedTruncation: spec.trusted_requirements?.manifest_truncated,
      exactPath: spec.trusted_requirements?.exact_path,
      count: spec.required_typed_fields?.includes("count"),
    },
  ]),
);
const SIGNALS = catalog.canonical_orders.evidence_signals;
const QUALIFIERS = catalog.canonical_orders.qualifiers;
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
    err(errors, "", "canonical decision exceeds 64 KiB", "output_capacity");
  if (d.status === "complete") return [...errors, ...validateV1(toV1Complete(d), context)];
  d.root_candidates.forEach((p: string, i: number) => {
    if (!context.manifestPaths.has(p))
      err(errors, `/decision/root_candidates/${i}`, "path must be manifest-known", "manifest_path_unknown");
  });
  const seenIssues = new Set<string>();
  d.issues.forEach((issue: any, i: number) => {
    const ip = `/decision/issues/${i}`;
    const key = cj({ ...issue, evidence: [...issue.evidence].map(canonical) });
    if (seenIssues.has(key)) err(errors, "/decision/issues", "normalized duplicate", "normalized_duplicate");
    seenIssues.add(key);
    const claims = new Set<string>();
    const seenEvidence = new Set<string>();
    issue.evidence.forEach((e: any, j: number) => {
      const ep = `${ip}/evidence/${j}`,
        spec = C[e.claim];
      if (!context.manifestPaths.has(e.path))
        err(errors, `${ep}/path`, "path must be manifest-known", "manifest_path_unknown");
      if (e.path === "." && e.claim !== "manifest_materially_truncated")
        err(errors, `${ep}/path`, "root evidence is reserved for trusted manifest truncation", "trusted_context_conflict");
      if (e.path !== "." && !context.manifestFilePaths.has(e.path))
        err(errors, `${ep}/path`, "evidence path must be a manifest file", "evidence_path_not_file");
      if (!spec?.issues.includes(issue.code))
        err(errors, `${ep}/claim`, "claim is incompatible with issue", "issue_claim_incompatible");
      if (
        spec?.trustedTruncation &&
        (!context.manifestTruncated || (spec.exactPath !== undefined && e.path !== spec.exactPath))
      )
        err(errors, ep, "claim conflicts with trusted context", "trusted_context_conflict");
      const ek = cj(e);
      if (seenEvidence.has(ek)) err(errors, `${ip}/evidence`, "normalized duplicate", "normalized_duplicate");
      seenEvidence.add(ek);
      claims.add(e.claim);
    });
    if (d.status === "incomplete") {
      const spec = I[issue.code];
      if (
        spec.recommendations.some(([code]) => code === "include_generated_sources_or_generator") &&
        ![...claims].some((claim) => C[claim].signal === "generated_source_reference")
      )
        err(errors, ip, "generated provenance claim is required");
      for (const [j, qc] of (issue.qualifiers ?? []).entries()) {
        const q = Q[qc];
        if (!q?.issues.includes(issue.code))
          err(errors, `${ip}/qualifiers/${j}`, "qualifier is incompatible with issue", "qualifier_incompatible");
        if (q?.all?.some((x) => !claims.has(x)) || (q?.any && !q.any.some((x) => claims.has(x))))
          err(errors, `${ip}/qualifiers/${j}`, "qualifier evidence is missing", "qualifier_evidence_missing");
      }
      const impact = [
        ...(spec.staticImpact && context.requestedStages.includes("static_audit")
          ? ["static_audit"]
          : []),
        ...stageList(spec.first, context.requestedStages).filter((x) => x !== "static_audit"),
      ];
      if (!impact.length) err(errors, ip, "issue is not relevant to requested stages", "issue_not_requested");
    } else {
      const spec = U[issue.code];
      if (spec?.trustedTruncation && !context.manifestTruncated)
        err(errors, ip, "issue conflicts with trusted context", "trusted_context_conflict");
    }
  });
  if (d.status === "incomplete") {
    const any = d.issues.some((x: any) => I[x.code].staticImpact);
    if (
      (any && !["partial", "none"].includes(d.source_visibility)) ||
      (!any && d.source_visibility !== "full")
    )
      err(errors, "/decision/source_visibility", "source visibility conflicts with issues", "source_visibility_conflict");
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
          availability:
            issue.evidence
              .map((x: any) => s.dependency?.availabilityIfClaim[x.claim])
              .find((value: string | undefined) => value !== undefined) ??
            s.dependency.availability,
          integrity: s.dependency.integrity,
          required_for: impact,
          declared_by: paths,
          locator_hint: s.dependency.locatorHint,
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
  // Frozen v2 intentionally maps local_first_party_dependency_absent to full
  // category=dependency plus dependency role=first_party_component. The legacy
  // compact-v1 validator requires that role to pair with category=first_party_component,
  // so only this validation clone is normalized; the emitted v2 projection is untouched.
  v.assessment.external_dependencies = v.assessment.external_dependencies.map((x: any) =>
    x.role === "first_party_component" && !categories.has("first_party_component")
      ? { ...x, role: "other" }
      : x,
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
