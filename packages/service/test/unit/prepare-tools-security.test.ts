import { createHash } from "node:crypto";
import {
  chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSourceManifest } from "../../src/features/prepare/source-manifest.js";
import { parseFlow } from "../../../../submodules/youngflow/src/spec.js";
import {
  PrepareToolError,
  PrepareToolState,
  isCanonicalRelativePath,
} from "../../../../flows/prepare/extensions/prepare-tools/index.js";
import { assembleMinimalSemanticDecision, canonicalMinimalSemanticDecisionJson } from "../../../../flows/prepare/extensions/prepare-tools/semantic-decision-v2.js";

const roots: string[] = [];
const repoRoot = join(import.meta.dirname, "../../../..");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prepare-tools-"));
  roots.push(root);
  const source = join(root, "source"), control = join(root, "control"), output = join(root, "output");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(control, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(source, "README.md"), "A safe project overview for the constrained planner.\nSecond line.\n");
  writeFileSync(join(source, "src/main.c"), "int main(void) { return 0; }\n");
  const manifest = generateSourceManifest(source);
  const input = {
    schema_version: "prepare-planner-input/v1",
    source_manifest: manifest,
    task_flags: { enable_poc: false, enable_exp: false, requested_stages: ["untrusted"] },
    capability_catalog: { version: "v1", capabilities: ["ssh", "shell", "compiler", "docker", "qemu_system"] },
    profile_recommendation_mode: "requirements_only",
  };
  const plannerInputPath = join(control, "planner-input.json");
  writeFileSync(plannerInputPath, JSON.stringify(input), { mode: 0o600 });
  const config = {
    sourceRoot: source, controlDir: control, outputDir: output, plannerInputPath,
    manifestSchemaPath: join(repoRoot, "packages/service/src/features/prepare/schemas/source-manifest-v1.schema.json"),
    planSchemaPath: join(repoRoot, "flows/prepare/schemas/prepare-assessment-plan-v1.schema.yaml"),
  };
  return { root, source, control, output, manifest, config, state: new PrepareToolState(config) };
}

function validPlan() {
  return {
    schema_version: "2.0",
    decision: {
      status: "incomplete", submission_shape: "project", intended_project: "Example project", root_candidates: ["."],
      confidence: 0.9, source_visibility: "partial",
      issues: [{ code: "base_source_absent", subject: "Example project base source", evidence: [{ path: "README.md", claim: "source_body_present" }] }],
    },
  };
}

function validCompletePlan() {
  return {
    schema_version: "2.0",
    decision: {
      status: "complete", submission_shape: "project", intended_project: "Example project", root_candidates: ["."],
      confidence: 0.9, static_visibility: "full",
      evidence: [
        { path: "README.md", signal: "project_metadata", observation: "Documentation identifies the project boundary." },
        { path: "src/main.c", signal: "source_tree_shape", observation: "The source body is present." },
      ],
      external_dependencies: [],
      sandbox_requirements: {
        target: { project_types: ["native"], languages: ["c"], build_systems: [], architectures: ["x86_64"], os_families: ["linux"], target_classes: ["source"] },
        required_capabilities: ["ssh", "shell"], optional_capabilities: ["compiler"],
        execution: { full_system: false, nested_docker: false, qemu_guest: false }, required_assets: [],
        dependency_egress: { required: false, reasons: [] }, confidence: 0.8,
      },
    },
  };
}

function assembled(decision: any, manifest: any) {
  const paths = new Set<string>([".", ...(manifest.tree ?? []).map((item: any) => item.path), ...(manifest.root_candidates ?? []).map((item: any) => item.path)]);
  return assembleMinimalSemanticDecision(decision, {
    requestedStages: ["static_audit"], capabilityCatalog: new Set(["ssh", "shell", "compiler", "docker", "qemu_system"]),
    manifestPaths: paths, manifestFilePaths: new Set((manifest.tree ?? []).filter((item: any) => item.type === "file").map((item: any) => item.path)),
    manifestRootCandidates: (manifest.root_candidates ?? []).map((item: any) => item.path), manifestTruncated: manifest.truncation?.truncated === true,
  });
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("prepare manifest/file tools", () => {
  it("T01/T02 paginates deterministically and rejects non-literal/unknown prefixes", () => {
    const f = fixture();
    try {
      const overview = f.state.readManifest();
      expect(overview).toMatchObject({ schema_version: "prepare-manifest-tool-result/v1", untrusted_data: true, section: "overview" });
      const first = f.state.readManifest({ section: "tree", cursor: 0, limit: 1 });
      const second = f.state.readManifest({ section: "tree", cursor: first.next_cursor, limit: 1 });
      expect(first.items[0].path < second.items[0].path).toBe(true);
      expect(() => f.state.readManifest({ section: "tree", path_prefix: "src/*" })).toThrow(PrepareToolError);
      expect(() => f.state.readManifest({ section: "tree", path_prefix: "missing" })).toThrow(PrepareToolError);
    } finally { f.state.close(); }
  });

  it("T03/T04 reads only canonical manifest-known hashed text files", () => {
    const f = fixture();
    try {
      expect(f.state.readFile({ path: "README.md", offset: 1, limit: 1 })).toMatchObject({
        untrusted_source_content: true, path: "README.md", line_start: 1, line_end: 1, truncated: true,
      });
      for (const path of ["/abs", "C:/x", "a/../b", "a/./b", "a\\b", "."]) expect(isCanonicalRelativePath(path)).toBe(false);
      writeFileSync(join(f.source, "new.txt"), "not in manifest");
      expect(() => f.state.readFile({ path: "new.txt" })).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SOURCE_INVALID", terminal: true }));
      expect(() => f.state.readManifest()).toThrowError(expect.objectContaining({ terminal: true }));
    } finally { f.state.close(); }
  });

  it("T05/T06 fails closed on hash change, symlink and secret slice", () => {
    const changed = fixture();
    writeFileSync(join(changed.source, "README.md"), "changed but same interface");
    expect(() => changed.state.readFile({ path: "README.md" })).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SOURCE_INVALID" }));
    changed.state.close();

    const linked = fixture();
    rmSync(join(linked.source, "README.md"));
    symlinkSync(join(linked.source, "src/main.c"), join(linked.source, "README.md"));
    expect(() => linked.state.readFile({ path: "README.md" })).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SOURCE_INVALID" }));
    linked.state.close();

    const parentLink = fixture();
    renameSync(join(parentLink.source, "src"), join(parentLink.source, "src-real"));
    symlinkSync(join(parentLink.source, "src-real"), join(parentLink.source, "src"));
    expect(() => parentLink.state.readFile({ path: "src/main.c" })).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SOURCE_INVALID" }));
    parentLink.state.close();

    const hardlinked = fixture();
    linkSync(join(hardlinked.source, "README.md"), join(hardlinked.source, "copy.md"));
    expect(() => hardlinked.state.readFile({ path: "README.md" })).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SOURCE_INVALID" }));
    hardlinked.state.close();

    const secret = fixture();
    const content = "api_key=do-not-return-this-secret";
    writeFileSync(join(secret.source, "README.md"), content);
    const updated = generateSourceManifest(secret.source);
    const input = JSON.parse(readFileSync(secret.config.plannerInputPath, "utf8"));
    input.source_manifest = updated;
    secret.state.close();
    writeFileSync(secret.config.plannerInputPath, JSON.stringify(input));
    const secretState = new PrepareToolState(secret.config);
    expect(() => secretState.readFile({ path: "README.md" })).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_OUTPUT_SENSITIVE" }));
    secretState.close();
  });

  it("T07 counts invalid calls and enforces manifest call budget", () => {
    const f = fixture();
    try {
      for (let i = 0; i < 12; i++) {
        try { f.state.readManifest({ section: "tree", path_prefix: "*" }); } catch { /* budget still consumed */ }
      }
      expect(() => f.state.readManifest()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_PLANNER_FAILED", terminal: true }));
      expect(f.state.budgets.manifestCalls).toBe(13);
    } finally { f.state.close(); }
  });
});

describe("prepare submit/postflight", () => {
  it("S01 atomically commits one 0600 plan and private receipt", async () => {
    const f = fixture();
    try {
      const result = await f.state.submitPlan(validPlan());
      expect(result.status).toBe("committed");
      expect(readdirSync(f.output)).toEqual(["assessment-plan.json"]);
      expect(statSync(join(f.output, "assessment-plan.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(f.output, "assessment-plan.json"), "utf8"))).toEqual(assembled(validPlan(), f.manifest));
      expect(f.state.postflight().plan_sha256).toBe(result.plan_sha256);
      expect(PrepareToolState.postflightExisting(f.config).plan_sha256).toBe(result.plan_sha256);
      expect(JSON.parse(readFileSync(join(f.control, "receipt.json"), "utf8"))).toMatchObject({ schema_version: "prepare-receipt/v2", decision_sha256: createHash("sha256").update(canonicalMinimalSemanticDecisionJson(validPlan() as any)).digest("hex") });
      expect(readFileSync(join(f.control, "receipt.json"), "utf8")).not.toContain("Example project");
    } finally { f.state.close(); }
  });

  it("S02/S03 permits two repairs then fails schema/semantic invalid with no file", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 2; i++) await expect(f.state.submitPlan({ schema_version: "bad", invalidAttempt: i })).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID", terminal: false });
      await expect(f.state.submitPlan({ schema_version: "still-bad" })).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID", terminal: true });
      expect(readdirSync(f.output)).toEqual([]);
    } finally { f.state.close(); }

    const repaired = fixture();
    await expect(repaired.state.submitPlan({ schema_version: "bad" })).rejects.toMatchObject({ terminal: false });
    await expect(repaired.state.submitPlan({ schema_version: "bad-again" })).rejects.toMatchObject({ terminal: false });
    await expect(repaired.state.submitPlan(validPlan())).resolves.toMatchObject({ status: "committed" });
    repaired.state.close();

    const legacyFull = fixture();
    const legacyPlan = assembled(validPlan(), legacyFull.manifest);
    await expect(legacyFull.state.submitPlan(legacyPlan)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID", terminal: false });
    expect(readdirSync(legacyFull.output)).toEqual([]);
    legacyFull.state.close();

    const semantic = fixture();
    const plan: any = validPlan();
    plan.decision.issues[0].evidence[0].path = "not-in-manifest";
    await expect(semantic.state.submitPlan(plan)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    semantic.state.close();

    const complete = fixture();
    await expect(complete.state.submitPlan(validCompletePlan())).resolves.toMatchObject({ status: "committed" });
    complete.state.close();

    const capability = fixture();
    const unknownCapability: any = validCompletePlan();
    unknownCapability.decision.sandbox_requirements.required_capabilities = ["ssh", "shell", "not_in_catalog"];
    await expect(capability.state.submitPlan(unknownCapability)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    capability.state.close();

    const firstPartyUnknown = fixture();
    const unknownFirstParty: any = validCompletePlan();
    unknownFirstParty.decision.external_dependencies = [{
      name: "local component", role: "first_party_component", availability: "unknown",
      integrity: "unknown", required_for: ["static_audit"], declared_by: ["README.md"], locator_hint: "",
    }];
    await expect(firstPartyUnknown.state.submitPlan(unknownFirstParty)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    firstPartyUnknown.state.close();

    const recommendation = fixture();
    const recommended: any = validCompletePlan();
    recommended.decision.sandbox_requirements.profile_recommendation = { recommended_profile_id: "linux-default" };
    await expect(recommendation.state.submitPlan(recommended)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    recommendation.state.close();
  });

  it("S04 returns exact safe v2 repair codes and field pointers without branch noise", async () => {
    type RepairCase = { canary: string; code: string; pointer: string; mutate: (plan: any) => void; base?: () => any };
    const uncertain = () => ({ schema_version: "2.0", decision: { status: "uncertain", submission_shape: "unknown", intended_project: "Unknown project", root_candidates: ["."], confidence: 0.5, issues: [{ code: "manifest_truncation_blocks_closure", evidence: [{ path: ".", claim: "manifest_materially_truncated" }] }] } });
    const cases: RepairCase[] = [
      { canary: "unknown-issue-value", code: "schema_enum", pointer: "/decision/issues/0/code", mutate: (p) => { p.decision.issues[0].code = "unknown-issue-value"; } },
      { canary: "unknown-claim-value", code: "schema_enum", pointer: "/decision/issues/0/evidence/0/claim", mutate: (p) => { p.decision.issues[0].evidence[0].claim = "unknown-claim-value"; } },
      { canary: "incompatible-claim-value", code: "issue_claim_incompatible", pointer: "/decision/issues/0/evidence/0/claim", mutate: (p) => { p.decision.issues[0].evidence[0].claim = "asset_pointer_without_content"; } },
      { canary: "qualifier-conflict-value", code: "qualifier_incompatible", pointer: "/decision/issues/0/qualifiers/0", mutate: (p) => { p.decision.issues[0].qualifiers = ["lfs_pointer_only"]; } },
      { canary: "qualifier-evidence-value", code: "qualifier_evidence_missing", pointer: "/decision/issues/0/qualifiers/0", mutate: (p) => { p.decision.issues[0].qualifiers = ["base_identity_unresolved"]; } },
      { canary: "missing/path/value", code: "manifest_path_unknown", pointer: "/decision/issues/0/evidence/0/path", mutate: (p) => { p.decision.issues[0].evidence[0].path = "missing/path/value"; } },
      { canary: "directory-path-value", code: "evidence_path_not_file", pointer: "/decision/issues/0/evidence/0/path", mutate: (p) => { p.decision.issues[0].evidence[0].path = "src"; } },
      { canary: "visibility-conflict-value", code: "source_visibility_conflict", pointer: "/decision/source_visibility", mutate: (p) => { p.decision.source_visibility = "full"; } },
      { canary: "not-requested-value", code: "issue_not_requested", pointer: "/decision/issues/0", mutate: (p) => { p.decision.source_visibility = "full"; p.decision.issues = [{ code: "required_runtime_asset_absent", subject: "runtime asset", evidence: [{ path: "README.md", claim: "asset_required_by_project" }] }]; } },
      { canary: "trusted-root-value", code: "trusted_context_conflict", pointer: "/decision/issues/0/evidence/0", mutate: () => {}, base: uncertain },
      { canary: "duplicate-value", code: "normalized_duplicate", pointer: "/decision/issues", mutate: (p) => { p.decision.issues.push(structuredClone(p.decision.issues[0])); } },
      { canary: "missing-subject-value", code: "schema_required", pointer: "/decision/issues/0/subject", mutate: (p) => { delete p.decision.issues[0].subject; } },
      { canary: "missing-count-value", code: "schema_required", pointer: "/decision/issues/0/evidence/0/count", mutate: (p) => { p.decision.issues[0].evidence[0].claim = "aggregate_test_corpus_detected"; } },
      { canary: "missing-complete-field-value", code: "schema_required", pointer: "/decision/sandbox_requirements", mutate: (p) => { delete p.decision.sandbox_requirements; }, base: validCompletePlan },
      { canary: "unknown-field-value", code: "schema_additional_property", pointer: "/decision", mutate: (p) => { p.decision.unknown_field = "unknown-field-value"; } },
      { canary: "invalid-status-value", code: "schema_enum", pointer: "/decision/status", mutate: (p) => { p.decision.status = "invalid-status-value"; } },
      { canary: "invalid-type-value", code: "schema_invalid", pointer: "/decision/confidence", mutate: (p) => { p.decision.confidence = "invalid-type-value"; } },
      { canary: "generated-provenance-value", code: "issue_claim_incompatible", pointer: "/decision/issues/0", mutate: (p) => { p.decision.issues = [{ code: "authoritative_first_party_input_absent", subject: "generated-provenance-value", evidence: [{ path: "README.md", claim: "source_body_present" }] }]; } },
      { canary: "X".repeat(129 * 1024), code: "output_capacity", pointer: "", mutate: (p) => { p.decision.issues[0].subject = "X".repeat(129 * 1024); } },
    ];
    for (const item of cases) {
      const f = fixture(); const plan: any = (item.base ?? validPlan)(); item.mutate(plan);
      try { await f.state.submitPlan(plan); throw new Error("expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(PrepareToolError);
        const prepareError = error as PrepareToolError;
        const details = prepareError.details ?? [];
        expect(Buffer.byteLength(prepareError.message)).toBeLessThanOrEqual(8 * 1024);
        expect(JSON.parse(prepareError.message)).toEqual({ error: "prepare_validation_failed", details });
        expect(details).toContainEqual({ instancePath: item.pointer, keyword: item.code, message: item.code });
        if (["missing-subject-value", "missing-count-value", "missing-complete-field-value", "invalid-status-value"].includes(item.canary)) expect(details).toHaveLength(1);
        expect(prepareError.message).not.toContain(item.canary);
        for (const detail of details) {
          expect(Object.keys(detail).sort()).toEqual(["instancePath", "keyword", "message"]);
          expect(detail.message).toBe(detail.keyword);
          expect(detail.instancePath).toMatch(/^(?:|\/(?:[A-Za-z0-9_~-]|~[01])*)+$/);
        }
      } finally { expect(readdirSync(f.output)).toEqual([]); expect(readdirSync(f.control)).toEqual(["planner-input.json"]); f.state.close(); }
    }
  });

  it("S02 validates the complete submit envelope within the repair budget", async () => {
    const oneMissing = fixture();
    await expect(oneMissing.state.submitEnvelope({})).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID", terminal: false });
    await expect(oneMissing.state.submitEnvelope({ plan: validPlan() })).resolves.toMatchObject({ status: "committed" });
    oneMissing.state.close();

    const twoMissing = fixture();
    await expect(twoMissing.state.submitEnvelope({})).rejects.toMatchObject({ terminal: false });
    await expect(twoMissing.state.submitEnvelope({})).rejects.toMatchObject({ terminal: false });
    await expect(twoMissing.state.submitEnvelope({ plan: validPlan() })).resolves.toMatchObject({ status: "committed" });
    twoMissing.state.close();

    const exhausted = fixture();
    for (let attempt = 0; attempt < 2; attempt++) await expect(exhausted.state.submitEnvelope({})).rejects.toMatchObject({ terminal: false });
    await expect(exhausted.state.submitEnvelope({})).rejects.toMatchObject({ terminal: true });
    expect(readdirSync(exhausted.output)).toEqual([]);
    exhausted.state.close();

    const extra = fixture();
    await expect(extra.state.submitEnvelope({ plan: validPlan(), extra: "not allowed" })).rejects.toMatchObject({ terminal: false });
    await expect(extra.state.submitEnvelope({ plan: validPlan() })).resolves.toMatchObject({ status: "committed" });
    extra.state.close();

    const sensitiveExtra = fixture();
    await expect(sensitiveExtra.state.submitEnvelope({ plan: validPlan(), extra: "api_key=must-not-pass" })).rejects.toMatchObject({ code: "ERR_PREPARE_OUTPUT_SENSITIVE", terminal: true });
    expect(readdirSync(sensitiveExtra.output)).toEqual([]);
    sensitiveExtra.state.close();
  });

  it("S05 sensitive plan and copied long source excerpt are terminal", async () => {
    const sensitive = fixture();
    const plan: any = validPlan(); plan.decision.issues[0].subject = "api_key=do-not-persist-value";
    await expect(sensitive.state.submitPlan(plan)).rejects.toMatchObject({ code: "ERR_PREPARE_OUTPUT_SENSITIVE", terminal: true });
    expect(readdirSync(sensitive.output)).toEqual([]); sensitive.state.close();

    const excerpt = fixture();
    const long = "A".repeat(80);
    writeFileSync(join(excerpt.source, "README.md"), long);
    const input = JSON.parse(readFileSync(excerpt.config.plannerInputPath, "utf8")); input.source_manifest = generateSourceManifest(excerpt.source);
    excerpt.state.close(); writeFileSync(excerpt.config.plannerInputPath, JSON.stringify(input));
    const state = new PrepareToolState(excerpt.config); state.readFile({ path: "README.md" });
    const copied: any = validPlan(); copied.decision.issues[0].subject = `Prefix ${long} suffix`;
    await expect(state.submitPlan(copied)).rejects.toMatchObject({ code: "ERR_PREPARE_OUTPUT_SENSITIVE", terminal: true });
    state.close();
  });

  it("S06 duplicate and concurrent submit fail closed and remove final", async () => {
    const duplicate = fixture();
    await duplicate.state.submitPlan(validPlan());
    await expect(duplicate.state.submitPlan(validPlan())).rejects.toMatchObject({ terminal: true });
    expect(readdirSync(duplicate.output)).toEqual([]); duplicate.state.close();

    const concurrent = fixture();
    const settled = await Promise.allSettled([concurrent.state.submitPlan(validPlan()), concurrent.state.submitPlan(validPlan())]);
    expect(settled.every((item) => item.status === "rejected")).toBe(true);
    expect(readdirSync(concurrent.output)).toEqual([]); concurrent.state.close();

    for (const invalidEnvelope of [{}, { plan: validPlan(), extra: "not allowed" }]) {
      const mixed = fixture();
      const mixedSettled = await Promise.allSettled([
        mixed.state.submitEnvelope({ plan: validPlan() }),
        mixed.state.submitEnvelope(invalidEnvelope),
      ]);
      expect(mixedSettled.every((item) => item.status === "rejected")).toBe(true);
      expect(readdirSync(mixed.output)).toEqual([]);
      mixed.state.close();
    }

    for (const invalidAfterCommit of [{}, { plan: validPlan(), extra: "not allowed" }]) {
      const committed = fixture();
      await committed.state.submitEnvelope({ plan: validPlan() });
      await expect(committed.state.submitEnvelope(invalidAfterCommit)).rejects.toMatchObject({ terminal: true });
      expect(readdirSync(committed.output)).toEqual([]);
      committed.state.close();
    }
  });

  it("S07 receipt/write, no-submit, or postflight durable-layout failure leaves no final plan", async () => {
    const noSubmit = fixture();
    expect(() => noSubmit.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_OUTPUT_MISSING", terminal: true }));
    expect(readdirSync(noSubmit.output)).toEqual([]);
    expect(readdirSync(noSubmit.control)).toEqual(["planner-input.json"]);
    noSubmit.state.close();

    const receiptFailure = fixture();
    mkdirSync(join(receiptFailure.control, "receipt.json"));
    await expect(receiptFailure.state.submitPlan(validPlan())).rejects.toMatchObject({ code: "ERR_PREPARE_PLANNER_FAILED", terminal: true });
    expect(readdirSync(receiptFailure.output)).toEqual([]);
    receiptFailure.state.close();

    const publicReceipt = fixture();
    await publicReceipt.state.submitPlan(validPlan());
    chmodSync(join(publicReceipt.control, "receipt.json"), 0o644);
    expect(() => publicReceipt.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_PLANNER_FAILED" }));
    expect(readdirSync(publicReceipt.output)).toEqual([]);
    publicReceipt.state.close();

    const wrongReceiptSchema = fixture();
    await wrongReceiptSchema.state.submitPlan(validPlan());
    const receipt = JSON.parse(readFileSync(join(wrongReceiptSchema.control, "receipt.json"), "utf8"));
    receipt.schema_version = "prepare-receipt/v0";
    writeFileSync(join(wrongReceiptSchema.control, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
    expect(() => wrongReceiptSchema.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_PLANNER_FAILED" }));
    expect(readdirSync(wrongReceiptSchema.output)).toEqual([]);
    wrongReceiptSchema.state.close();

    const forged = fixture();
    await forged.state.submitPlan(validPlan());
    const forgedPath = join(forged.output, "assessment-plan.json");
    const forgedPlan = JSON.parse(readFileSync(forgedPath, "utf8"));
    forgedPlan.sandbox_plan = validCompletePlan().sandbox_requirements;
    const forgedRaw = JSON.stringify(forgedPlan, null, 2) + "\n";
    writeFileSync(forgedPath, forgedRaw, { mode: 0o600 });
    const forgedReceiptPath = join(forged.control, "receipt.json");
    const forgedReceipt = JSON.parse(readFileSync(forgedReceiptPath, "utf8"));
    forgedReceipt.plan_sha256 = createHash("sha256").update(forgedRaw).digest("hex");
    writeFileSync(forgedReceiptPath, JSON.stringify(forgedReceipt), { mode: 0o600 });
    expect(() => forged.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SCHEMA_INVALID" }));
    expect(readdirSync(forged.output)).toEqual([]);
    forged.state.close();

    const forgedSummary = fixture();
    await forgedSummary.state.submitPlan(validPlan());
    const summaryPath = join(forgedSummary.output, "assessment-plan.json");
    const summaryPlan = JSON.parse(readFileSync(summaryPath, "utf8")); summaryPlan.source_assessment.summary = "Facts removed from deterministic summary.";
    const summaryRaw = JSON.stringify(summaryPlan, null, 2) + "\n"; writeFileSync(summaryPath, summaryRaw, { mode: 0o600 });
    const summaryReceiptPath = join(forgedSummary.control, "receipt.json");
    const summaryReceipt = JSON.parse(readFileSync(summaryReceiptPath, "utf8")); summaryReceipt.plan_sha256 = createHash("sha256").update(summaryRaw).digest("hex");
    writeFileSync(summaryReceiptPath, JSON.stringify(summaryReceipt), { mode: 0o600 });
    expect(() => forgedSummary.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_SCHEMA_INVALID" }));
    expect(readdirSync(forgedSummary.output)).toEqual([]); forgedSummary.state.close();

    const forgedRoot = fixture();
    const forgedRootInput = JSON.parse(readFileSync(forgedRoot.config.plannerInputPath, "utf8"));
    forgedRootInput.source_manifest.truncation = { truncated: true, reasons: ["max_files"] };
    forgedRoot.state.close();
    writeFileSync(forgedRoot.config.plannerInputPath, JSON.stringify(forgedRootInput), {
      mode: 0o600,
    });
    const forgedRootState = new PrepareToolState(forgedRoot.config);
    await forgedRootState.submitPlan({
      schema_version: "2.0",
      decision: {
        status: "uncertain",
        submission_shape: "unknown",
        intended_project: "Truncated project",
        root_candidates: ["."],
        confidence: 0.5,
        issues: [
          {
            code: "manifest_truncation_blocks_closure",
            evidence: [{ path: ".", claim: "manifest_materially_truncated" }],
          },
        ],
      },
    });
    const forgedRootPath = join(forgedRoot.output, "assessment-plan.json");
    const forgedRootPlan = JSON.parse(readFileSync(forgedRootPath, "utf8"));
    forgedRootPlan.source_assessment.evidence[0].observation = "Untrusted alternate root fact.";
    const forgedRootRaw = JSON.stringify(forgedRootPlan, null, 2) + "\n";
    writeFileSync(forgedRootPath, forgedRootRaw, { mode: 0o600 });
    const forgedRootReceiptPath = join(forgedRoot.control, "receipt.json");
    const forgedRootReceipt = JSON.parse(readFileSync(forgedRootReceiptPath, "utf8"));
    forgedRootReceipt.plan_sha256 = createHash("sha256").update(forgedRootRaw).digest("hex");
    writeFileSync(forgedRootReceiptPath, JSON.stringify(forgedRootReceipt), { mode: 0o600 });
    expect(() => forgedRootState.postflight()).toThrowError(
      expect.objectContaining({ code: "ERR_PREPARE_SCHEMA_INVALID" }),
    );
    expect(readdirSync(forgedRoot.output)).toEqual([]);
    forgedRootState.close();

    const extraReceipt = fixture();
    await extraReceipt.state.submitPlan(validPlan());
    const extraReceiptPath = join(extraReceipt.control, "receipt.json");
    const extraReceiptValue = JSON.parse(readFileSync(extraReceiptPath, "utf8")); extraReceiptValue.plan = { forbidden: true };
    writeFileSync(extraReceiptPath, JSON.stringify(extraReceiptValue), { mode: 0o600 });
    expect(() => extraReceipt.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_PLANNER_FAILED" }));
    extraReceipt.state.close();

    const extra = fixture();
    await extra.state.submitPlan(validPlan());
    writeFileSync(join(extra.output, "extra.txt"), "not allowed");
    expect(() => extra.state.postflight()).toThrowError(expect.objectContaining({ code: "ERR_PREPARE_PLANNER_FAILED" }));
    expect(readdirSync(extra.output)).toEqual([]);
    extra.state.close();
  });
});

describe("prepare static security boundary", () => {
  it("N2 selects only v2 and preserves v1.1/v1 rollback bytes", () => {
    const hash = (path: string) =>
      createHash("sha256")
        .update(readFileSync(join(repoRoot, path)))
        .digest("hex");
    const frozen = {
      "flows/prepare/agents/prepare-agent-v2.md":
        "ddc8f1bdf3a454149a021e9bee52f186bc28c283727a35d4b1cc1c188f08f783",
      "flows/prepare/tasks/prepare-v2.md":
        "3d0e5f47a24d76c604e8650506120b22710b0c08861fd0a71d80fcf646955998",
      "flows/prepare/skills/prepare-compact-submit-v2/SKILL.md":
        "f7d6841e06dcf3cb53481ad2898ee9aa850070a234003c4acd09010376a78945",
      "flows/prepare/agents/prepare-agent-v1.1.md":
        "914e0346340707cb3e03075b19cecb05070b52b0ed097a41c0a3e598a800ed97",
      "flows/prepare/tasks/prepare-v1.1.md":
        "4c442cab8e5163fbd85c8210bd9b57c101471fc8b7b247288fe8589abfdebbd6",
      "flows/prepare/skills/prepare-compact-submit-v1-1/SKILL.md":
        "35769e547216f67584a3a7d5d26cd203f9563612dac80a3d42dda98d54cc28d8",
      "flows/prepare/agents/prepare-agent.md":
        "049ca71f365b63f5902a57efddc3146e4db6b4e9e69dd7bcf54423809fdeba9a",
      "flows/prepare/tasks/prepare.md":
        "ef0132ed1fdd406dfbf50bd402801df471cadd3236cd98990b706e584ad71c56",
      "flows/prepare/skills/prepare-tool-protocol/SKILL.md":
        "f919515109f9eb0d2d27538356633d6d4c31ec1bf1c2e7eaee968ea846fc72b1",
    };
    for (const [path, digest] of Object.entries(frozen)) expect(hash(path), path).toBe(digest);
    const v2Schema = JSON.parse(readFileSync(join(repoRoot, "flows/prepare/schemas/prepare-semantic-decision-v2.schema.json"), "utf8"));
    const v2Catalog = JSON.parse(readFileSync(join(repoRoot, "flows/prepare/schemas/prepare-minimal-semantic-catalog-v2.json"), "utf8"));
    const v2Skill = readFileSync(join(repoRoot, "flows/prepare/skills/prepare-compact-submit-v2/SKILL.md"), "utf8");
    const count = v2Schema.$defs.typedEvidence.properties.count;
    expect(v2Skill).toContain(`integer \`count\` from ${count.minimum} through ${count.maximum}`);
    expect(v2Skill).toContain(`non-empty \`issues\` (maximum ${v2Schema.$defs.incompleteDecision.properties.issues.maxItems})`);
    expect(v2Catalog.incomplete_issue_catalog.build_manifest_absent.static_impact).toBe(false);
    expect(v2Skill).toContain("when every issue is `build_manifest_absent` or a build/runtime asset/configuration issue it must be `full`");
    expect(v2Schema.$defs.target.properties.build_systems.minItems).toBeUndefined();
    for (const field of ["project_types", "languages", "architectures", "os_families", "target_classes"]) expect(v2Schema.$defs.target.properties[field].minItems).toBe(1);
    expect(v2Schema.$defs.sandboxRequirements.required).not.toContain("optional_capabilities");
    expect(v2Schema.$defs.sandboxRequirements.required).not.toContain("required_assets");
    for (const rule of [
      "\"path\":\"CMakeLists.txt\"",
      "\"path\":\"src/main.c\"",
      "`availability=missing|declared_download|unknown`",
      "`build_systems` may be empty when no build system applies",
      "the platform assembler supplies empty arrays",
      "`nested_docker=true` requires capability `docker`",
      "`qemu_guest=true` requires `full_system=true`, capability `qemu_system`, and at least one required asset",
      "egress never repairs first-party source",
      "Required and optional capabilities cannot overlap",
      "Do not submit Profile recommendation fields or IDs",
    ]) expect(v2Skill).toContain(rule);
    const flowPath = join(repoRoot, "flows/prepare/flow.prepare.yaml");
    const flow = readFileSync(flowPath, "utf8");
    expect(flow).toContain("timeout: 660");
    expect(flow).toContain("recursion_limit: 8");
    expect(flow).toContain("timeout: 600");
    expect(flow).toContain("agent: prepare-agent-v2.md");
    expect(flow).toContain("skills: [prepare-compact-submit-v2]");
    expect(flow).toContain("task: prepare-v2.md");
    expect(
      [...flow.matchAll(/^    - (read_project_manifest|read_project_file|submit_plan)$/gm)].map(
        (match) => match[1],
      ),
    ).toEqual(["read_project_manifest", "read_project_file", "submit_plan"]);
    expect(hash("worker-assets/prepare-mode.sh")).toBe(
      "269f2c987d2554e914a469ab5f13aa85d6f7a77b16173062bdecb832ec24e485",
    );
    const prepareMode = readFileSync(join(repoRoot, "worker-assets/prepare-mode.sh"), "utf8");
    expect(prepareMode.indexOf('mkdir "$owner_dir"')).toBeLessThan(prepareMode.indexOf("trap cleanup EXIT"));
    expect(prepareMode).toContain('! -path "$owner_dir"');
    expect(prepareMode.lastIndexOf('rm -f "$identity"')).toBeGreaterThan(prepareMode.indexOf('! -path "$owner_dir"'));
    const spec = parseFlow(flowPath);
    expect(spec.defaultAgent).toBe("prepare-agent-v2.md");
    expect(spec.defaultTools).toEqual([
      "read_project_manifest",
      "read_project_file",
      "submit_plan",
    ]);
    expect(spec.stages[0]).toMatchObject({
      id: "prepare",
      skills: ["prepare-compact-submit-v2"],
      task: "prepare-v2.md",
      timeout: 600,
      errorStrategy: "stop",
      executionPolicy: "prepare-restricted",
    });
  });
  it("A01-A05/R03 extension has exactly three registrations and no exec/network/MCP imports", () => {
    const source = readFileSync(
      join(repoRoot, "flows/prepare/extensions/prepare-tools/index.ts"),
      "utf8",
    );
    expect(
      [...source.matchAll(/name: "(read_project_manifest|read_project_file|submit_plan)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["read_project_manifest", "read_project_file", "submit_plan"]);
    expect(source).not.toMatch(
      /node:(?:child_process|http|https|net|tls|dns|dgram)|\bfetch\s*\(|WebSocket|SandboxPlane|MCP/,
    );
    expect(source).not.toContain("pi.exec");
    expect(source).toContain("prepare-semantic-decision-v2.schema.json");
    expect(source).not.toContain("prepare-semantic-decision-v1.schema.yaml");
  });
});
