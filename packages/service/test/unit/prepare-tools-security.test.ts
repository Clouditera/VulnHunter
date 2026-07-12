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
import { assembleAssessmentPlan, canonicalSemanticDecisionJson } from "../../../../flows/prepare/extensions/prepare-tools/semantic-decision.js";

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
    schema_version: "1.0",
    assessment: {
      status: "incomplete", submission_shape: "project", intended_project: "Example project", root_candidates: ["."],
      confidence: 0.9, static_visibility: "partial",
      evidence: [{ path: "README.md", signal: "source_tree_shape", observation: "Documentation is present without a build entrypoint." }],
      missing: [{
        category: "build_manifest", name: "Build definition", required_by: "The submitted source needs a project build entrypoint.",
        evidence_paths: ["README.md"], impact: ["static_audit"], recoverable_from_submission: false,
        recommendation_codes: ["include_build_files"], fix: "  Include the project build definition.  ",
      }],
      uncertainties: [], external_dependencies: [],
    },
    sandbox_requirements: null,
  };
}

function validCompletePlan() {
  const plan: any = validPlan();
  plan.assessment.status = "complete";
  plan.assessment.static_visibility = "full";
  plan.assessment.missing = [];
  plan.assessment.evidence = [
    { path: "README.md", signal: "project_metadata", observation: "Documentation identifies the project boundary." },
    { path: "src/main.c", signal: "source_tree_shape", observation: "The source body is present." },
  ];
  plan.sandbox_requirements = {
    target: { project_types: ["native"], languages: ["c"], build_systems: [], architectures: ["x86_64"], os_families: ["linux"], target_classes: ["source"] },
    required_capabilities: ["ssh", "shell"], optional_capabilities: ["compiler"],
    execution: { full_system: false, nested_docker: false, qemu_guest: false }, required_assets: [],
    dependency_egress: { required: false, reasons: [] }, confidence: 0.8,
  };
  return plan;
}

function assembled(decision: any, manifest: any) {
  const paths = new Set<string>([".", ...(manifest.tree ?? []).map((item: any) => item.path), ...(manifest.root_candidates ?? []).map((item: any) => item.path)]);
  return assembleAssessmentPlan(decision, {
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
      expect(JSON.parse(readFileSync(join(f.control, "receipt.json"), "utf8"))).toMatchObject({ schema_version: "prepare-receipt/v2", decision_sha256: createHash("sha256").update(canonicalSemanticDecisionJson(validPlan() as any)).digest("hex") });
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
    plan.assessment.evidence[0].path = "not-in-manifest";
    await expect(semantic.state.submitPlan(plan)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    semantic.state.close();

    const complete = fixture();
    await expect(complete.state.submitPlan(validCompletePlan())).resolves.toMatchObject({ status: "committed" });
    complete.state.close();

    const capability = fixture();
    const unknownCapability: any = validCompletePlan();
    unknownCapability.sandbox_requirements.required_capabilities = ["ssh", "shell", "not_in_catalog"];
    await expect(capability.state.submitPlan(unknownCapability)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    capability.state.close();

    const recommendation = fixture();
    const recommended: any = validCompletePlan();
    recommended.sandbox_requirements.profile_recommendation = { recommended_profile_id: "linux-default" };
    await expect(recommendation.state.submitPlan(recommended)).rejects.toMatchObject({ code: "ERR_PREPARE_SCHEMA_INVALID" });
    recommendation.state.close();
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
    const plan: any = validPlan(); plan.assessment.missing[0].fix = "api_key=do-not-persist-value";
    await expect(sensitive.state.submitPlan(plan)).rejects.toMatchObject({ code: "ERR_PREPARE_OUTPUT_SENSITIVE", terminal: true });
    expect(readdirSync(sensitive.output)).toEqual([]); sensitive.state.close();

    const excerpt = fixture();
    const long = "A".repeat(80);
    writeFileSync(join(excerpt.source, "README.md"), long);
    const input = JSON.parse(readFileSync(excerpt.config.plannerInputPath, "utf8")); input.source_manifest = generateSourceManifest(excerpt.source);
    excerpt.state.close(); writeFileSync(excerpt.config.plannerInputPath, JSON.stringify(input));
    const state = new PrepareToolState(excerpt.config); state.readFile({ path: "README.md" });
    const copied: any = validPlan(); copied.assessment.missing[0].fix = `Prefix ${long} suffix`;
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

  it("S07 receipt/write or postflight durable-layout failure leaves no final plan", async () => {
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
  it("R2 selects only the frozen v1.1 prompt bundle and preserves v1.0 rollback bytes", () => {
    const hash = (path: string) => createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
    expect(hash("flows/prepare/agents/prepare-agent-v1.1.md")).toBe("914e0346340707cb3e03075b19cecb05070b52b0ed097a41c0a3e598a800ed97");
    expect(hash("flows/prepare/tasks/prepare-v1.1.md")).toBe("4c442cab8e5163fbd85c8210bd9b57c101471fc8b7b247288fe8589abfdebbd6");
    expect(hash("flows/prepare/skills/prepare-compact-submit-v1-1/SKILL.md")).toBe("35769e547216f67584a3a7d5d26cd203f9563612dac80a3d42dda98d54cc28d8");
    expect(hash("flows/prepare/agents/prepare-agent.md")).toBe("049ca71f365b63f5902a57efddc3146e4db6b4e9e69dd7bcf54423809fdeba9a");
    expect(hash("flows/prepare/tasks/prepare.md")).toBe("ef0132ed1fdd406dfbf50bd402801df471cadd3236cd98990b706e584ad71c56");
    expect(hash("flows/prepare/skills/prepare-tool-protocol/SKILL.md")).toBe("f919515109f9eb0d2d27538356633d6d4c31ec1bf1c2e7eaee968ea846fc72b1");
    const flowPath = join(repoRoot, "flows/prepare/flow.prepare.yaml");
    const flow = readFileSync(flowPath, "utf8");
    expect(flow).toContain("timeout: 660"); expect(flow).toContain("recursion_limit: 8"); expect(flow).toContain("timeout: 600");
    expect(flow).toContain("agent: prepare-agent-v1.1.md"); expect(flow).toContain("skills: [prepare-compact-submit-v1-1]"); expect(flow).toContain("task: prepare-v1.1.md");
    expect([...flow.matchAll(/^    - (read_project_manifest|read_project_file|submit_plan)$/gm)].map((match) => match[1])).toEqual(["read_project_manifest", "read_project_file", "submit_plan"]);
    expect(hash("worker-assets/prepare-mode.sh")).toBe("d73ddd74e92691ce4b46deed7ad60218514f0101b6d850b74adf15deda20ab4a");
    const spec = parseFlow(flowPath);
    expect(spec.defaultAgent).toBe("prepare-agent-v1.1.md");
    expect(spec.defaultTools).toEqual(["read_project_manifest", "read_project_file", "submit_plan"]);
    expect(spec.stages[0]).toMatchObject({ id: "prepare", skills: ["prepare-compact-submit-v1-1"], task: "prepare-v1.1.md", timeout: 600, errorStrategy: "stop", executionPolicy: "prepare-restricted" });
  });
  it("A01-A05/R03 extension has exactly three registrations and no exec/network/MCP imports", () => {
    const source = readFileSync(join(repoRoot, "flows/prepare/extensions/prepare-tools/index.ts"), "utf8");
    expect([...source.matchAll(/name: "(read_project_manifest|read_project_file|submit_plan)"/g)].map((match) => match[1])).toEqual([
      "read_project_manifest", "read_project_file", "submit_plan",
    ]);
    expect(source).not.toMatch(/node:(?:child_process|http|https|net|tls|dns|dgram)|\bfetch\s*\(|WebSocket|SandboxPlane|MCP/);
    expect(source).not.toContain("pi.exec");
  });
});
