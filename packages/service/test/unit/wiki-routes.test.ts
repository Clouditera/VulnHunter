import { describe, expect, it } from "vitest";
import { PROFILER_ARTIFACT_PATHS, isSafeWikiFilename, sortWikiPages, slimCoverageMap } from "../../src/features/wiki/routes.js";

describe("isSafeWikiFilename", () => {
  it("accepts plain .md basenames", () => {
    expect(isSafeWikiFilename("index.md")).toBe(true);
    expect(isSafeWikiFilename("auth-credential.md")).toBe(true);
    expect(isSafeWikiFilename("crypto_tls.v2.md")).toBe(true);
  });
  it("rejects path traversal and nested paths", () => {
    expect(isSafeWikiFilename("../secret.md")).toBe(false);
    expect(isSafeWikiFilename("a/b.md")).toBe(false);
    expect(isSafeWikiFilename("..%2fetc.md")).toBe(false);
  });
  it("rejects non-.md and empty", () => {
    expect(isSafeWikiFilename("index.yaml")).toBe(false);
    expect(isSafeWikiFilename("index")).toBe(false);
    expect(isSafeWikiFilename("")).toBe(false);
  });
});

describe("sortWikiPages", () => {
  it("puts index.md first, overview.md second, rest alphabetical", () => {
    const ordered = sortWikiPages(["zeta.md", "overview.md", "alpha.md", "index.md"]);
    expect(ordered.map((p) => p.name)).toEqual([
      "index.md",
      "overview.md",
      "alpha.md",
      "zeta.md",
    ]);
  });
  it("maps to {name, path} with knowledge/wiki/ prefix", () => {
    const [first] = sortWikiPages(["index.md"]);
    expect(first).toEqual({ name: "index.md", path: "knowledge/wiki/index.md" });
  });
  it("works without index/overview present", () => {
    const ordered = sortWikiPages(["b.md", "a.md"]);
    expect(ordered.map((p) => p.name)).toEqual(["a.md", "b.md"]);
  });
});

describe("PROFILER_ARTIFACT_PATHS", () => {
  it("tries root, new knowledge fallback, then legacy profiler path", () => {
    expect(PROFILER_ARTIFACT_PATHS).toEqual([
      "profiler.yaml",
      "knowledge/profiler.yaml",
      "profiler/project-profiler.yaml",
    ]);
  });
});

describe("slimCoverageMap", () => {
  it("returns [] for undefined", () => {
    expect(slimCoverageMap(undefined)).toEqual([]);
  });
  it("slims file entries to path/coverage/read_lines/total_lines (no file counts)", () => {
    const out = slimCoverageMap({
      "src/a.c": { path: "src/a.c", total_lines: 100, read_lines: 50, coverage: 0.5, files: 0, covered_files: 0, ranges: [[1, 50]], stages: ["recon"] } as never,
    });
    expect(out).toEqual([{ path: "src/a.c", coverage: 0.5, read_lines: 50, total_lines: 100, files: 0, covered_files: 0 }]);
    // heavy fields dropped
    expect(out[0]).not.toHaveProperty("ranges");
    expect(out[0]).not.toHaveProperty("stages");
  });
  it("keeps file counts for directory entries", () => {
    const out = slimCoverageMap({
      "src": { path: "src", files: 10, covered_files: 4, total_lines: 1000, read_lines: 300, coverage: 0.3 },
    });
    expect(out[0]).toEqual({ path: "src", coverage: 0.3, read_lines: 300, total_lines: 1000, files: 10, covered_files: 4 });
  });
  it("falls back to map key when path field absent + defaults missing numbers", () => {
    const out = slimCoverageMap({ "x.c": {} as never });
    expect(out[0]).toEqual({ path: "x.c", coverage: 0, read_lines: 0, total_lines: 0 });
  });
});
