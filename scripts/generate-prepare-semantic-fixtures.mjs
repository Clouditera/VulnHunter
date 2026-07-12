#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const require = createRequire(join(repoRoot, "packages/service/package.json"));
const yaml = require("js-yaml");
const fixtureRoot = join(repoRoot, "packages/service/test/fixtures/prepare-semantic");
const oraclePath = join(fixtureRoot, "oracles-v1.yaml");
const indexPath = join(fixtureRoot, "generated-fixtures.json");
const checkOnly = process.argv.slice(2).includes("--check");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return false;
  const normalized = posix.normalize(value);
  return normalized === value && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function filesBelow(root) {
  const out = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const stat = statSync(child, { throwIfNoEntry: true });
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) out.push(relative(root, child).split("\\").join("/"));
      else throw new Error(`unsafe generated fixture entry: ${child}`);
    }
  };
  walk(root);
  return out;
}

const oracleBytes = readFileSync(oraclePath);
const oracle = yaml.load(oracleBytes.toString("utf8"));
if (oracle?.oracle_version !== "1.0" || !Array.isArray(oracle.fixtures) || oracle.fixtures.length !== 15) {
  throw new Error("expected frozen prepare semantic oracle v1.0 with 15 generated fixtures");
}

const seenIds = new Set();
const expected = new Map();
for (const fixture of oracle.fixtures) {
  if (!/^[a-z0-9_]+$/.test(fixture?.id ?? "") || seenIds.has(fixture.id)) throw new Error(`invalid fixture id: ${fixture?.id}`);
  seenIds.add(fixture.id);
  const files = fixture?.source_blueprint?.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length === 0) throw new Error(`missing source blueprint: ${fixture.id}`);
  for (const [path, content] of Object.entries(files)) {
    if (!safeRelativePath(path) || typeof content !== "string") throw new Error(`invalid blueprint file: ${fixture.id}/${path}`);
    expected.set(`${fixture.id}/${path}`, Buffer.from(content, "utf8"));
  }
}

const index = {
  schema_version: "prepare-semantic-generated-fixtures/v1",
  oracle_file: "oracles-v1.yaml",
  oracle_sha256: sha256(oracleBytes),
  fixtures: [...seenIds].map((id) => ({
    id,
    files: [...expected.entries()]
      .filter(([path]) => path.startsWith(`${id}/`))
      .map(([path, bytes]) => ({ path: path.slice(id.length + 1), sha256: sha256(bytes), bytes: bytes.length })),
  })),
};
const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);

if (checkOnly) {
  const expectedPaths = new Set(["oracles-v1.yaml", "generated-fixtures.json", ...expected.keys()]);
  const actualPaths = new Set(filesBelow(fixtureRoot));
  for (const path of expectedPaths) if (!actualPaths.has(path)) throw new Error(`missing generated fixture file: ${path}`);
  for (const path of actualPaths) if (!expectedPaths.has(path)) throw new Error(`unexpected generated fixture file: ${path}`);
  for (const [path, bytes] of expected) {
    if (!readFileSync(join(fixtureRoot, path)).equals(bytes)) throw new Error(`generated fixture drift: ${path}`);
  }
  if (!readFileSync(indexPath).equals(indexBytes)) throw new Error("generated fixture index drift");
  process.stdout.write(`prepare semantic fixtures verified: ${seenIds.size} fixtures, ${expected.size} files\n`);
} else {
  for (const id of seenIds) rmSync(join(fixtureRoot, id), { recursive: true, force: true });
  for (const [path, bytes] of expected) {
    const target = join(fixtureRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode: 0o644 });
  }
  writeFileSync(indexPath, indexBytes, { mode: 0o644 });
  process.stdout.write(`prepare semantic fixtures generated: ${seenIds.size} fixtures, ${expected.size} files\n`);
}
