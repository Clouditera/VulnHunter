#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { assertPrepareSemanticOracle, canonicalPlanDigest } from "../packages/service/test/support/prepare-semantic-oracle.mjs";

const repo = resolve(import.meta.dirname, "..");
const require = createRequire(join(repo, "packages/service/package.json"));
const yaml = require("js-yaml");
const fixtureRoot = join(repo, "packages/service/test/fixtures/prepare-semantic");
const oracle = yaml.load(readFileSync(join(fixtureRoot, "oracles-v1.yaml"), "utf8"));

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: run-prepare-semantic-regression.mjs --image IMAGE --models FILE --model MODEL --model-label LABEL [--runs 3] [--fixture ID] [--stonesoup-source DIR] [--network NAME] [--results FILE]\n");
  process.exit(message ? 2 : 0);
}

const args = process.argv.slice(2);
const options = { runs: oracle.repeat_runs, fixtures: [], network: null, stonesoup: null, results: null };
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === "--help") usage();
  const value = args[++i];
  if (!value) usage(`missing value for ${key}`);
  if (key === "--image") options.image = value;
  else if (key === "--models") options.models = resolve(value);
  else if (key === "--model") options.model = value;
  else if (key === "--model-label") options.modelLabel = value;
  else if (key === "--runs") options.runs = Number(value);
  else if (key === "--fixture") options.fixtures.push(value);
  else if (key === "--stonesoup-source") options.stonesoup = resolve(value);
  else if (key === "--network") options.network = value;
  else if (key === "--results") options.results = resolve(value);
  else usage(`unknown option ${key}`);
}
if (!options.image || !options.models || !options.model || !options.modelLabel) usage("image, models, model and model-label are required");
if (!/^[A-Za-z0-9_.:@/-]{1,128}$/.test(options.modelLabel)) usage("model-label must be a non-secret identifier");
if (!Number.isSafeInteger(options.runs) || options.runs !== 3) usage("frozen stability gate requires exactly 3 runs");
if (!statSync(options.models).isFile()) usage("models must be a file");
let generateSourceManifest;
try {
  ({ generateSourceManifest } = await import("../packages/service/dist/features/prepare/source-manifest.js"));
} catch {
  throw new Error("service build is required before running semantic regression: pnpm --filter @vulnagent/service build");
}

const generated = new Map(oracle.fixtures.map((fixture) => [fixture.id, { source: join(fixtureRoot, fixture.id), fixture, kind: "directory" }]));
const external = oracle.external_fixtures[0];
if (options.stonesoup) generated.set(external.id, { source: options.stonesoup, fixture: external, kind: "archive" });
const selected = options.fixtures.length ? options.fixtures : [...oracle.fixtures.map((fixture) => fixture.id), ...(options.stonesoup ? [external.id] : [])];
for (const id of selected) if (!generated.has(id)) usage(`unknown or unavailable fixture ${id}`);

function runtimeVersion(command) {
  const run = spawnSync("docker", ["run", "--rm", "--entrypoint", command, options.image, "--version"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (run.status !== 0) throw new Error(`cannot read ${command} version from image`);
  return `${run.stdout}${run.stderr}`.trim().split("\n").at(-1);
}

function sourceTexts(root) {
  const texts = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name); const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && stat.size <= 256 * 1024) texts.push(readFileSync(path, "utf8"));
    }
  };
  walk(root); return texts;
}

const runtime = { image: options.image, youngflow: runtimeVersion("youngflow"), pi: runtimeVersion("pi"), model: options.modelLabel };
const result = { schema_version: "prepare-semantic-regression/v1", oracle_sha256: canonicalPlanDigest(readFileSync(join(fixtureRoot, "oracles-v1.yaml"))), runtime, fixtures: [] };

for (const id of selected) {
  const selectedFixture = generated.get(id);
  const expected = selectedFixture.fixture.expected;
  const limits = selectedFixture.fixture.generator_options?.limits;
  const manifest = generateSourceManifest(selectedFixture.source, { sourceKind: selectedFixture.kind, limits });
  const normalizedRuns = [];
  const digests = [];
  for (let run = 1; run <= options.runs; run++) {
    const temp = mkdtempSync(join(tmpdir(), `prepare-semantic-${id}-`)); chmodSync(temp, 0o700);
    const control = join(temp, "control"); const output = join(temp, "output"); mkdirSync(control, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
    const planner = join(temp, "planner.json");
    writeFileSync(planner, JSON.stringify({ schema_version: "prepare-planner-input/v1", source_manifest: manifest, ...oracle.planner_input_defaults }), { mode: 0o600 });
    const containerName = `m304-${id.slice(0, 28)}-${randomUUID().slice(0, 8)}`;
    const dockerArgs = ["run", "--rm", "--name", containerName];
    if (options.network) dockerArgs.push("--network", options.network);
    dockerArgs.push(
      "-e", "MODE=prepare", "-e", `V_PREPARE_MODEL=${options.model}`,
      "-e", "PREPARE_SOURCE_ROOT=/source", "-e", "PREPARE_CONTROL_DIR=/control", "-e", "PREPARE_OUTPUT_DIR=/output",
      "-e", "PREPARE_PLANNER_INPUT=/input/planner.json",
      "-e", "PREPARE_MANIFEST_SCHEMA=/opt/vulnagent/flows/prepare/schemas/source-manifest-v1.schema.json",
      "-e", "PREPARE_PLAN_SCHEMA=/opt/vulnagent/flows/prepare/schemas/prepare-assessment-plan-v1.schema.yaml",
      "-e", "DATABASE_URL=FORBIDDEN_CANARY", "-e", "MINIO_SECRET_KEY=FORBIDDEN_CANARY", "-e", "SSH_PRIVATE_KEY=FORBIDDEN_CANARY",
      "-v", `${selectedFixture.source}:/source:ro`, "-v", `${control}:/control`, "-v", `${output}:/output`,
      "-v", `${planner}:/input/planner.json:ro`, "-v", `${options.models}:/opt/vulnagent/flows/prepare/models.json:ro`, options.image,
    );
    const executed = spawnSync("docker", dockerArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 720_000 });
    try {
      if (executed.status !== 0) throw new Error(`${id} run ${run}: restricted flow exit ${executed.status ?? "timeout"}`);
      const outputNames = readdirSync(output).sort();
      if (JSON.stringify(outputNames) !== JSON.stringify(["assessment-plan.json"])) throw new Error(`${id} run ${run}: output set is not exact`);
      if (readdirSync(control).length !== 0) throw new Error(`${id} run ${run}: private control directory was not cleaned`);
      const planPath = join(output, "assessment-plan.json");
      if ((statSync(planPath).mode & 0o777) !== 0o600) throw new Error(`${id} run ${run}: plan mode is not 0600`);
      const readPlan = spawnSync("docker", ["run", "--rm", "--entrypoint", "cat", "-v", `${output}:/out:ro`, options.image, "/out/assessment-plan.json"], { maxBuffer: 1024 * 1024 });
      if (readPlan.status !== 0) throw new Error(`${id} run ${run}: cannot read committed plan`);
      const planBytes = readPlan.stdout;
      const plan = JSON.parse(planBytes.toString("utf8"));
      const normalized = assertPrepareSemanticOracle(plan, expected, {
        capabilityCatalog: oracle.planner_input_defaults.capability_catalog.capabilities,
        sourceTexts: selectedFixture.kind === "directory" ? sourceTexts(selectedFixture.source) : [],
      });
      normalizedRuns.push(normalized); digests.push(canonicalPlanDigest(planBytes));
    } finally {
      spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      // Raw model output, tool results, sessions and the full plan are never copied
      // into regression evidence. Only normalized fields and digests survive.
      rmSync(temp, { recursive: true, force: true });
    }
  }
  const stable = JSON.stringify(normalizedRuns[0]);
  if (!normalizedRuns.every((item) => JSON.stringify(item) === stable)) throw new Error(`${id}: normalized semantic fields drifted across runs`);
  result.fixtures.push({ id, runs: options.runs, normalized: normalizedRuns[0], plan_sha256: digests });
  process.stdout.write(`${id}: PASS (${options.runs} runs)\n`);
}

const resultBytes = `${JSON.stringify(result, null, 2)}\n`;
if (options.results) { writeFileSync(options.results, resultBytes, { mode: 0o600, flag: "wx" }); process.stdout.write(`results: ${options.results}\n`); }
else process.stdout.write(resultBytes);
