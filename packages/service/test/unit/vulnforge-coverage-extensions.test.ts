import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Node can import .ts only via the CLI flags below; the flow's coverage-core is
// plain TypeScript with node:fs imports only, so running it through
// `node --experimental-strip-types` keeps this test hermetic (no build step).
import {
  getCoveragePaths,
  loadCoverageMap,
  recordReadCoverageEvent,
} from "../../../../flows/vulnforge/extensions/coverage-core.ts";

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("coverage-core CODE_EXTENSIONS whitelist (HALL-14)", () => {
  it("tracks .lua/.erl/.ex families and other common audit languages", () => {
    // A multi-language audit target: every file below must show up in the
    // coverage map, otherwise the decide/report stages see phantom 0% coverage.
    const target = tempRoot("coverage-ext-target-");
    const files: Record<string, string> = {
      // issue-named families
      "game.lua": "print('x')\n",
      "hotfix.luau": "print('x')\n",
      "srv.erl": "ok.\n",
      "include/app.hrl": "-define(X, 1).\n",
      "lib/thing.ex": "defmodule T do\nend\n",
      "lib/thing_test.exs": "1 + 1\n",
      // already-known languages the flow ships image/manifest awareness for
      "elixir/mix.exs": "defmodule M do\nend\n",
      "erlang/pipe.escript": "#!/usr/bin/env escript\n",
      "solidity/Vault.sol": "contract V {}\n",
      "zig/main.zig": "pub fn main() void {}\n",
      // common C-family spellings
      "cc/module.cc": "int main() {}\n",
      "cxx/module.cxx": "int main() {}\n",
      "objc/ui.m": "@interface A @end\n",
      "objcpp/ui.mm": "@interface A @end\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      const full = join(target, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }

    const outputDir = tempRoot("coverage-ext-out-");
    const { jsonPath, jsonlPath } = getCoveragePaths(outputDir);
    const map = loadCoverageMap(jsonPath, target, outputDir);

    const tracked = new Set(Object.keys(map.files));
    for (const rel of Object.keys(files)) {
      expect(tracked, `${rel} must be tracked as a code file`).toContain(rel);
    }
    // sanity: the map summary counts them all
    expect(map.summary.files).toBe(Object.keys(files).length);

    // read events on a previously-untracked type must record too
    recordReadCoverageEvent({
      jsonlPath,
      targetRoot: target,
      stage: "hunt",
      input: { path: join(target, "game.lua"), limit: 10 },
    });
    const map2 = loadCoverageMap(jsonPath, target, outputDir);
    const reloaded = map2.files["game.lua"];
    expect(reloaded).toBeDefined();
  });

  it("still ignores non-code files and case variants are tracked", () => {
    const target = tempRoot("coverage-ext-target2-");
    writeFileSync(join(target, "Config.LUA"), "print('x')\n");
    writeFileSync(join(target, "logo.png"), "binary-ish\n");
    writeFileSync(join(target, "data.bin"), "\x00\x01\x02\n");

    const outputDir = tempRoot("coverage-ext-out2-");
    const { jsonPath } = getCoveragePaths(outputDir);
    const map = loadCoverageMap(jsonPath, target, outputDir);

    // whitelist match is case-insensitive (extname → toLowerCase)
    expect(Object.keys(map.files)).toContain("Config.LUA");
    expect(Object.keys(map.files)).not.toContain("logo.png");
    expect(Object.keys(map.files)).not.toContain("data.bin");
  });
});
