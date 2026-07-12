import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  assembleMinimalSemanticDecision,
  canonicalAssessmentPlanJson,
  canonicalMinimalSemanticDecisionJson,
  validateMinimalSemanticDecision,
  type AssembleContext,
} from "../../../../flows/prepare/extensions/prepare-tools/semantic-decision-v2.js";
import { assertPrepareSemanticOracle } from "../support/prepare-semantic-oracle.mjs";
import { assembleAssessmentPlan as assembleV1 } from "../../../../flows/prepare/extensions/prepare-tools/semantic-decision.js";

const root = join(import.meta.dirname, "../../../..");
const oracle: any = parseYaml(
  readFileSync(
    join(root, "packages/service/test/fixtures/prepare-semantic/oracles-v1.yaml"),
    "utf8",
  ),
);
const yamlSchema: any = parseYaml(
  readFileSync(
    join(root, "flows/prepare/schemas/prepare-semantic-decision-v2.schema.yaml"),
    "utf8",
  ),
);
const jsonSchema = JSON.parse(
  readFileSync(
    join(root, "flows/prepare/schemas/prepare-semantic-decision-v2.schema.json"),
    "utf8",
  ),
);
const catalog: any = parseYaml(
  readFileSync(
    join(root, "flows/prepare/schemas/prepare-minimal-semantic-catalog-v2.yaml"),
    "utf8",
  ),
);
const canonicalMapping: any = JSON.parse(
  readFileSync(
    join(root, "packages/service/test/fixtures/prepare-semantic-v2/canonical-mapping-v2.json"),
    "utf8",
  ),
);
const fullSchema: any = parseYaml(
  readFileSync(join(root, "flows/prepare/schemas/prepare-assessment-plan-v1.schema.yaml"), "utf8"),
);
const validateFull = new Ajv2020({ strict: false }).compile(fullSchema);
const requested = ["static_audit", "build", "poc", "exp"] as const;
const capabilities = new Set(oracle.planner_input_defaults.capability_catalog.capabilities);
function paths(files: string[], roots: string[] = ["."]) {
  const out = new Set<string>([".", ...roots, ...files]);
  for (const f of files) {
    const p = f.split("/");
    while (p.length > 1) {
      p.pop();
      out.add(p.join("/"));
    }
  }
  return out;
}
function ctx(files: string[], roots: string[] = ["."], truncated = false): AssembleContext {
  return {
    requestedStages: requested,
    capabilityCatalog: capabilities,
    manifestPaths: paths(files, roots),
    manifestFilePaths: new Set(files),
    manifestRootCandidates: roots,
    manifestTruncated: truncated,
  };
}
function files(f: any) {
  return Object.keys(f.source_blueprint.files);
}
function complete(f: any) {
  const fs = files(f),
    e = f.expected,
    roots = e.root_candidates_contains ?? ["."],
    evidencePaths = [...new Set([...(e.evidence_paths_contains ?? []), fs[0]])],
    signals = e.evidence_signals_contains ?? [];
  const evidence = evidencePaths.map((path: string, index: number) => ({
    path,
    signal: signals[index] ?? (index === 0 ? "project_metadata" : "source_tree_shape"),
    observation: `Bounded structural fact ${index + 1}.`,
  }));
  if (!evidence.some((x: any) => ["project_metadata", "build_entrypoint"].includes(x.signal)))
    evidence.push({
      path: evidencePaths[0],
      signal: "project_metadata",
      observation: "Project metadata declares the boundary.",
    });
  if (!evidence.some((x: any) => x.signal === "source_tree_shape"))
    evidence.push({
      path: evidencePaths.at(-1),
      signal: "source_tree_shape",
      observation: "Submitted source boundary is present.",
    });
  const deps = (e.external_dependency_roles_contains ?? []).map((role: string) => ({
    name: role,
    role,
    availability: "declared_download",
    integrity: "pinned",
    required_for: ["build"],
    declared_by: [evidencePaths[0]],
    locator_hint: "declared package coordinate",
  }));
  return {
    schema_version: "2.0",
    decision: {
      status: "complete",
      submission_shape: e.submission_shape,
      intended_project: `fixture ${f.id}`,
      root_candidates: roots,
      confidence: Math.max(e.confidence_min ?? 0.8, 0.9),
      static_visibility: "full",
      evidence,
      external_dependencies: deps,
      sandbox_requirements: {
        target: {
          project_types: ["source_project"],
          languages: ["mixed"],
          build_systems: ["declared"],
          architectures: ["x86_64"],
          os_families: ["linux"],
          target_classes: ["userspace"],
        },
        required_capabilities: [
          ...new Set(["ssh", "shell", ...(e.required_capabilities_contains ?? [])]),
        ],
        execution: { full_system: false, nested_docker: false, qemu_guest: false },
        required_assets: [],
        dependency_egress: {
          required: e.dependency_egress_required ?? false,
          reasons: e.dependency_egress_required
            ? ["Declared third-party package download is required."]
            : [],
        },
        confidence: 0.9,
      },
    },
  };
}
const mapping: Record<string, (f: any) => any> = {
  incomplete_patch_only_unlocated_base: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "patch_set",
      intended_project:
        "patch target with base source absent and base version not reliably locatable",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "partial",
      issues: [
        {
          code: "base_source_absent",
          subject: "matching base source",
          qualifiers: ["base_identity_unresolved"],
          evidence: [
            { path: "fix.patch", claim: "patch_submission_detected" },
            { path: "fix.patch", claim: "patch_targets_unsubmitted_base" },
            { path: "README.md", claim: "external_base_declared" },
            { path: "README.md", claim: "base_identity_not_declared" },
          ],
        },
      ],
    },
  }),
  incomplete_test_only: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "test_corpus",
      intended_project: "widget test corpus",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "partial",
      issues: [
        {
          code: "base_source_absent",
          subject: "widget base source",
          evidence: [
            { path: "tests/CMakeLists.txt", claim: "test_corpus_submission_detected" },
            { path: "tests/test_widget.c", claim: "test_references_unsubmitted_base" },
          ],
        },
      ],
    },
  }),
  incomplete_generated_only_missing_authoritative_inputs: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "project",
      intended_project: "generated API project",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "partial",
      issues: [
        {
          code: "authoritative_first_party_input_absent",
          subject: "schema/api.idl authoritative generator input",
          evidence: [
            { path: "CMakeLists.txt", claim: "project_build_entrypoint_present" },
            { path: "generated/api.c", claim: "source_body_present" },
            { path: "GENERATION.md", claim: "generated_authoritative_input_declared_absent" },
          ],
        },
      ],
    },
  }),
  incomplete_missing_generated_output_and_chain: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "project",
      intended_project: "generated output project",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "partial",
      issues: [
        {
          code: "generated_chain_incomplete",
          subject: "generated/version.c",
          evidence: [
            { path: "CMakeLists.txt", claim: "generated_output_declared_absent" },
            { path: "CMakeLists.txt", claim: "generation_chain_not_submitted" },
            { path: "src/main.c", claim: "source_body_present" },
          ],
        },
      ],
    },
  }),
  incomplete_missing_submodule: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "project",
      intended_project: "submodule project",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "partial",
      issues: [
        {
          code: "submodule_content_absent",
          subject: "vendor/crypto submodule",
          evidence: [
            { path: ".gitmodules", claim: "submodule_declared_without_content" },
            { path: "CMakeLists.txt", claim: "local_path_declared_absent" },
          ],
        },
      ],
    },
  }),
  incomplete_required_lfs_asset: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "project",
      intended_project: "runtime model project",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "full",
      issues: [
        {
          code: "required_runtime_asset_absent",
          subject: "assets/model.bin",
          qualifiers: ["lfs_pointer_only"],
          evidence: [
            { path: "CMakeLists.txt", claim: "asset_required_by_project" },
            { path: "assets/model.bin", claim: "asset_pointer_without_content" },
          ],
        },
      ],
    },
  }),
  incomplete_missing_local_vendor_dependency: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "incomplete",
      submission_shape: "project",
      intended_project: "local vendor project",
      root_candidates: ["."],
      confidence: 0.9,
      source_visibility: "partial",
      issues: [
        {
          code: "local_first_party_dependency_absent",
          subject: "vendor/localcrypto",
          evidence: [
            { path: "README.md", claim: "local_first_party_dependency_declared" },
            { path: "CMakeLists.txt", claim: "local_path_declared_absent" },
          ],
        },
      ],
    },
  }),
  uncertain_insufficient_project_evidence: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "uncertain",
      submission_shape: "unknown",
      intended_project: "unbounded parser fragment",
      root_candidates: ["."],
      confidence: 0.7,
      issues: [
        {
          code: "project_evidence_insufficient",
          evidence: [
            { path: "README.md", claim: "project_scope_not_established" },
            { path: "src/parser.c", claim: "isolated_source_body_present" },
          ],
        },
      ],
    },
  }),
  uncertain_undeclared_multi_project: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "uncertain",
      submission_shape: "multi_project",
      intended_project: "api and web roots",
      root_candidates: ["api", "web"],
      confidence: 0.7,
      issues: [
        {
          code: "project_scope_ambiguous",
          evidence: [
            { path: "api/go.mod", claim: "complete_root_without_scope_relation" },
            { path: "web/package.json", claim: "complete_root_without_scope_relation" },
          ],
        },
      ],
    },
  }),
  uncertain_material_manifest_truncation: (f) => ({
    schema_version: "2.0",
    decision: {
      status: "uncertain",
      submission_shape: "project",
      intended_project: "truncated project",
      root_candidates: ["."],
      confidence: 0.7,
      issues: [
        {
          code: "manifest_truncation_blocks_closure",
          evidence: [{ path: ".", claim: "manifest_materially_truncated" }],
        },
      ],
    },
  }),
};
function canonical(f: any) {
  return f.expected.status === "complete" ? complete(f) : mapping[f.id](f);
}
const stoneRoots = [
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
  "231338-v2.0.0",
];
function stonesoup() {
  const fs = [
    "manifest.sarif",
    "148805-v1.0.0/manifest.sarif",
    "148805-v1.0.0/install-dependencies.sh",
    "148805-v1.0.0/Makefile",
  ];
  return {
    decision: {
      schema_version: "2.0",
      decision: {
        status: "incomplete",
        submission_shape: "test_corpus",
        intended_project: "Asterisk 10.2.0 20-root test corpus overlays",
        root_candidates: stoneRoots,
        confidence: 0.99,
        source_visibility: "partial",
        issues: [
          {
            code: "base_source_absent",
            subject: "Asterisk 10.2.0 base source tree",
            qualifiers: ["overlay_set"],
            evidence: [
              { path: fs[0], claim: "aggregate_test_corpus_detected", count: 20 },
              { path: fs[1], claim: "external_base_version_declared" },
              { path: fs[2], claim: "installer_fetches_external_base" },
              { path: fs[3], claim: "build_requires_absent_base_tree" },
            ],
          },
        ],
      },
    },
    context: ctx(fs, stoneRoots),
  };
}

describe("Prepare minimal semantic decision v2 pure projection", () => {
  it("keeps frozen schema mirrors/catalog counts exact", () => {
    expect(jsonSchema).toEqual(yamlSchema);
    expect(Object.keys(catalog.incomplete_issue_catalog)).toHaveLength(10);
    expect(Object.keys(catalog.uncertainty_issue_catalog)).toHaveLength(6);
    expect(Object.keys(catalog.qualifier_catalog)).toHaveLength(3);
    expect(Object.keys(catalog.claim_catalog)).toHaveLength(30);
    expect(() => new Ajv2020({ strict: true }).compile(jsonSchema)).not.toThrow();
  });
  it("maps all 15 fixtures plus Stonesoup through the existing full oracle", () => {
    const cases = oracle.fixtures.map((f: any) => ({
      id: f.id,
      expected: f.expected,
      decision: canonical(f),
      context: ctx(
        files(f),
        f.expected.root_candidates_contains ?? ["."],
        (f.expected.warning_codes_contains ?? []).includes("manifest_truncated"),
      ),
    }));
    const s = stonesoup();
    cases.push({
      id: "incomplete_stonesoup_asterisk_test_corpus",
      expected: {
        status: "incomplete",
        submission_shape: "test_corpus",
        missing_categories: ["base_source"],
        missing_names_must_convey: ["Asterisk 10.2.0 base source tree"],
        uncertainty_codes: [],
        stage_status: { static_audit: "limited", build: "blocked", poc: "blocked", exp: "blocked" },
        sandbox_plan: null,
        root_candidates_contains: stoneRoots,
        evidence_paths_contains: [
          "manifest.sarif",
          "148805-v1.0.0/manifest.sarif",
          "148805-v1.0.0/install-dependencies.sh",
          "148805-v1.0.0/Makefile",
        ],
        recommendation_codes_contains: ["include_base_source", "submit_complete_project"],
        external_dependency_roles_contains: ["base_project_source"],
        confidence_min: 0.95,
      },
      ...s,
    });
    expect(cases).toHaveLength(16);
    expect(canonicalMapping.fixtures.map((x: any) => x.id)).toEqual(cases.map((x: any) => x.id));
    for (const c of cases) {
      const mapped = canonicalMapping.fixtures.find((x: any) => x.id === c.id),
        d = c.decision.decision;
      expect(d).toMatchObject({ status: mapped.status, submission_shape: mapped.submission_shape });
      if (mapped.issues) {
        expect(d.issues.map((x: any) => x.code)).toEqual(mapped.issues.map((x: any) => x.code));
        for (let i = 0; i < mapped.issues.length; i++) {
          expect(d.issues[i].qualifiers ?? []).toEqual(mapped.issues[i].qualifiers ?? []);
          expect([...new Set(d.issues[i].evidence.map((x: any) => x.claim))].sort()).toEqual(
            [...mapped.issues[i].claims].sort(),
          );
        }
      }
      expect(validateMinimalSemanticDecision(c.decision, c.context), c.id).toEqual([]);
      const plan = assembleMinimalSemanticDecision(c.decision, c.context);
      expect(validateFull(plan), `${c.id}: ${JSON.stringify(validateFull.errors)}`).toBe(true);
      expect(
        () =>
          assertPrepareSemanticOracle(plan, c.expected, { capabilityCatalog: [...capabilities] }),
        c.id,
      ).not.toThrow();
      expect(plan.sandbox_plan === null).toBe(c.expected.status !== "complete");
    }
  });
  it("covers every frozen issue/claim/qualifier cross-product fail-closed", () => {
    const claimEntries = Object.entries(catalog.claim_catalog) as [string, any][];
    for (const [code, spec] of Object.entries(catalog.incomplete_issue_catalog) as [
      string,
      any,
    ][]) {
      const [claim, claimSpec] = claimEntries.find(([, x]) => x.allowed_issues.includes(code))!;
      const evidence: any = { path: "file.txt", claim };
      if (claimSpec.required_typed_fields?.includes("count")) evidence.count = 2;
      const d: any = {
        schema_version: "2.0",
        decision: {
          status: "incomplete",
          submission_shape: "project",
          intended_project: "catalog project",
          root_candidates: ["."],
          confidence: 0.9,
          source_visibility: spec.static_impact ? "partial" : "full",
          issues: [{ code, subject: "required object", evidence: [evidence] }],
        },
      };
      const c = ctx(["file.txt"]);
      expect(validateMinimalSemanticDecision(d, c), code).toEqual([]);
      const plan = assembleMinimalSemanticDecision(d, c);
      expect(validateFull(plan)).toBe(true);
      expect(plan.source_assessment.missing_components[0]).toMatchObject({
        category: spec.full_category,
        name: "required object",
        expected_by: spec.expected_by_template.replace("{subject}", "required object"),
      });
      expect(plan.source_assessment.evidence[0]).toMatchObject({
        signal: claimSpec.signal,
        observation: claimSpec.observation_template
          .replace("{subject}", "required object")
          .replace("{count}", "2"),
      });
      expect(plan.source_assessment.user_recommendations).toEqual(
        spec.recommendations.map((x: any) => ({
          code: x.code,
          message: x.message_template.replace("{subject}", "required object"),
        })),
      );
      const incompatible = claimEntries.find(([, x]) => !x.allowed_issues.includes(code));
      if (incompatible) {
        const bad = structuredClone(d);
        bad.decision.issues[0].evidence[0].claim = incompatible[0];
        delete bad.decision.issues[0].evidence[0].count;
        expect(validateMinimalSemanticDecision(bad, c).length).toBeGreaterThan(0);
      }
    }
    for (const [code, spec] of Object.entries(catalog.uncertainty_issue_catalog) as [
      string,
      any,
    ][]) {
      const [claim, claimSpec] = claimEntries.find(([, x]) => x.allowed_issues.includes(code))!;
      const trunc = spec.trusted_requirements?.manifest_truncated === true,
        e: any = { path: trunc ? "." : "file.txt", claim };
      if (claimSpec.required_typed_fields?.includes("count")) e.count = 2;
      const d: any = {
        schema_version: "2.0",
        decision: {
          status: "uncertain",
          submission_shape: "unknown",
          intended_project: "catalog project",
          root_candidates: ["."],
          confidence: 0.7,
          issues: [{ code, evidence: [e] }],
        },
      };
      const c = ctx(["file.txt"], ["."], trunc);
      expect(validateMinimalSemanticDecision(d, c), code).toEqual([]);
      const plan = assembleMinimalSemanticDecision(d, c);
      expect(validateFull(plan)).toBe(true);
      expect(plan.source_assessment.uncertainties[0]).toMatchObject({
        code: spec.full_code,
        description: spec.description_template,
      });
      expect(plan.source_assessment.user_recommendations).toEqual(
        spec.recommendations.map((x: any) => ({ code: x.code, message: x.message_template })),
      );
    }
    for (const [claim, spec] of claimEntries) {
      const code = spec.allowed_issues[0],
        incomplete = code in catalog.incomplete_issue_catalog,
        trunc = spec.trusted_requirements?.manifest_truncated === true,
        e: any = { path: trunc ? "." : "file.txt", claim };
      if (spec.required_typed_fields?.includes("count")) e.count = 2;
      const issue: any = { code, evidence: [e] };
      if (incomplete) issue.subject = "object";
      const d: any = {
        schema_version: "2.0",
        decision: {
          status: incomplete ? "incomplete" : "uncertain",
          submission_shape: "project",
          intended_project: "claim coverage",
          root_candidates: ["."],
          confidence: 0.8,
          ...(incomplete
            ? {
                source_visibility: catalog.incomplete_issue_catalog[code].static_impact
                  ? "partial"
                  : "full",
              }
            : {}),
          issues: [issue],
        },
      };
      expect(validateMinimalSemanticDecision(d, ctx(["file.txt"], ["."], trunc)), claim).toEqual(
        [],
      );
    }
    const qualifierCases = [
      ["base_source_absent", "base_identity_unresolved", "base_identity_not_declared"],
      ["base_source_absent", "overlay_set", "patch_targets_unsubmitted_base"],
      ["required_runtime_asset_absent", "lfs_pointer_only", "asset_pointer_without_content"],
    ];
    for (const [code, q, claim] of qualifierCases) {
      const d: any = {
        schema_version: "2.0",
        decision: {
          status: "incomplete",
          submission_shape: "project",
          intended_project: "qualified",
          root_candidates: ["."],
          confidence: 0.9,
          source_visibility: code === "required_runtime_asset_absent" ? "full" : "partial",
          issues: [
            { code, subject: "object", qualifiers: [q], evidence: [{ path: "file.txt", claim }] },
          ],
        },
      };
      expect(validateMinimalSemanticDecision(d, ctx(["file.txt"])), q).toEqual([]);
    }
  });
  it("is byte stable and preserves complete branch semantics", () => {
    const f = oracle.fixtures[0],
      d = canonical(f),
      c = ctx(files(f));
    const before = JSON.stringify(d),
      bytes = canonicalAssessmentPlanJson(assembleMinimalSemanticDecision(d, c));
    for (let i = 0; i < 100; i++)
      expect(canonicalAssessmentPlanJson(assembleMinimalSemanticDecision(d, c))).toBe(bytes);
    expect(JSON.stringify(d)).toBe(before);
    expect(canonicalMinimalSemanticDecisionJson(d)).toBe(
      canonicalMinimalSemanticDecisionJson(structuredClone(d)),
    );
    const p = JSON.parse(bytes);
    const x = d.decision,
      v1 = {
        schema_version: "1.0",
        assessment: {
          status: "complete",
          submission_shape: x.submission_shape,
          intended_project: x.intended_project,
          root_candidates: x.root_candidates,
          confidence: x.confidence,
          static_visibility: "full",
          evidence: x.evidence,
          missing: [],
          uncertainties: [],
          external_dependencies: x.external_dependencies,
        },
        sandbox_requirements: x.sandbox_requirements,
      };
    expect(p).toEqual(assembleV1(v1, c));
    expect(p.source_assessment.status).toBe("complete");
    expect(p.sandbox_plan.requirements.required_capabilities).toEqual(
      [...p.sandbox_plan.requirements.required_capabilities].sort(),
    );
  });
  it("rejects forbidden non-complete fields and invalid cross-products", () => {
    const f = oracle.fixtures.find((x: any) => x.id === "incomplete_patch_only_unlocated_base"),
      base = canonical(f),
      c = ctx(files(f));
    for (const mutate of [
      (d: any) => (d.decision.impact = ["build"]),
      (d: any) => (d.decision.sandbox_requirements = null),
      (d: any) => (d.decision.issues[0].evidence[0].claim = "asset_pointer_without_content"),
      (d: any) => (d.decision.issues[0].qualifiers = ["lfs_pointer_only"]),
      (d: any) => (d.decision.issues[0].evidence[0].path = "missing/file"),
      (d: any) => (d.decision.extra = true),
    ]) {
      const d = structuredClone(base);
      mutate(d);
      expect(validateMinimalSemanticDecision(d, c).length).toBeGreaterThan(0);
      expect(() => assembleMinimalSemanticDecision(d, c)).toThrow();
    }
  });
  it("enforces source visibility, trusted truncation, aggregate count, duplicates, sensitive and requested-stage relevance", () => {
    const lfs = oracle.fixtures.find((x: any) => x.id === "incomplete_required_lfs_asset"),
      ld = canonical(lfs),
      lc = ctx(files(lfs));
    ld.decision.source_visibility = "partial";
    expect(validateMinimalSemanticDecision(ld, lc).length).toBeGreaterThan(0);
    const trunc = oracle.fixtures.find(
        (x: any) => x.id === "uncertain_material_manifest_truncation",
      ),
      td = canonical(trunc);
    expect(validateMinimalSemanticDecision(td, ctx(files(trunc)))).not.toEqual([]);
    const st = stonesoup();
    const noCount = structuredClone(st.decision);
    delete noCount.decision.issues[0].evidence[0].count;
    expect(validateMinimalSemanticDecision(noCount, st.context).length).toBeGreaterThan(0);
    const dup = structuredClone(st.decision);
    dup.decision.issues[0].evidence.push(structuredClone(dup.decision.issues[0].evidence[0]));
    expect(validateMinimalSemanticDecision(dup, st.context).length).toBeGreaterThan(0);
    const secret = structuredClone(st.decision);
    secret.decision.issues[0].subject = "api_key=forbidden";
    expect(validateMinimalSemanticDecision(secret, st.context).length).toBeGreaterThan(0);
    const runtime = canonical(lfs);
    expect(
      validateMinimalSemanticDecision(runtime, { ...lc, requestedStages: ["static_audit"] }).length,
    ).toBeGreaterThan(0);
  });
});
