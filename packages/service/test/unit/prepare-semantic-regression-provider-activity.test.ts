import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const repo = join(import.meta.dirname, "../../../..");
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function run(counter: "api_errors" | "retries") {
  const root = mkdtempSync(join(tmpdir(), `prepare-provider-${counter}-`)); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin);
  const log = join(root, "docker.log"), progress = join(root, "progress.json"), result = join(root, "result.json"), models = join(root, "models.json"), privateTmp = join(root, "tmp"); mkdirSync(privateTmp);
  writeFileSync(models, '{"providers":{}}\n');
  const apiErrors = counter === "api_errors" ? 1 : 0, retries = counter === "retries" ? 1 : 0;
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n  *"--entrypoint youngflow"*) echo 'youngflow 0.7.1'; exit 0;;\n  *"--entrypoint pi"*) echo '0.79.6'; exit 0;;\n  rm\\ -f*) exit 0;;\nesac\nprintf '%s\\n' 'DONE: exit=0 duration=12ms turns=2 tools=1 tokens_in=2 tokens_out=2 tokens_cache_read=0 tokens_cache_write=0 tokens_total=4 api_errors=${apiErrors} retries=${retries}' >&2\nexit 0\n`);
  chmodSync(docker, 0o755);
  const image = `sha256:${"1".repeat(64)}`;
  const execution = spawnSync(process.execPath, [join(repo, "scripts/run-prepare-semantic-regression.mjs"), "--image", image, "--models", models, "--model", "qa/fake", "--model-label", "qa-fake", "--runs", "3", "--fixture", "complete_cmake_with_tests_and_vendor", "--results", result, "--safe-progress", progress], {
    cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: privateTmp, M304_SAFE_RUN_UUID: "12345678-1234-4234-8234-123456789abc", M304_SAFE_MAIN_COMMIT: "a".repeat(40) },
  });
  return { execution, progress: JSON.parse(readFileSync(progress, "utf8")), log: readFileSync(log, "utf8").trim().split("\n"), result, privateTmp };
}

describe("Prepare semantic regression provider-activity fail-fast", () => {
  for (const counter of ["api_errors", "retries"] as const) {
    it(`fails run 1 when outer Worker succeeds but DONE reports ${counter}`, () => {
      const observed = run(counter);
      expect(observed.execution.status).toBe(1);
      expect(observed.progress).toMatchObject({ fixture_id: "complete_cmake_with_tests_and_vendor", run_index: 1, phase: "container_exit", state: "failed", attempted_runs: 1, completed_runs: 0, runtime_category: "provider_failure" });
      expect(observed.progress.safe_counters[counter]).toBe(1);
      expect(observed.log.filter((line) => line.includes("--entrypoint youngflow"))).toHaveLength(1);
      expect(observed.log.filter((line) => line.includes("--entrypoint pi"))).toHaveLength(1);
      expect(observed.log.filter((line) => line.startsWith("run --rm --name"))).toHaveLength(1);
      expect(observed.log.filter((line) => line.startsWith("rm -f"))).toHaveLength(1);
      expect(() => readFileSync(observed.result)).toThrow();
      expect(readdirSync(observed.privateTmp)).toEqual([]);
    });
  }
});
