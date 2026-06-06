import { describe, expect, it } from "vitest";
import { isSafeWikiFilename, sortWikiPages } from "../../src/features/wiki/routes.js";

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
