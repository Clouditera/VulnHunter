import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditCompletionEngineRun, evaluateAuditCompletion, fingerprintAuditCompletion } from "../../src/features/workers/audit-completion.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const deadline = join(repoRoot, "worker-assets/run-with-deadline.py");
const artifacts = join(repoRoot, "worker-assets/timeout-finalize-artifacts.py");
const scanMode = join(repoRoot, "worker-assets/scan-mode.sh");
const roots: string[] = [];

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "timeout-finalize-")); roots.push(root);
  const out = join(root, "out"), control = join(root, "control");
  mkdirSync(join(out, "findings", "BUG-1"), { recursive: true });
  mkdirSync(join(out, "knowledge"), { recursive: true });
  mkdirSync(join(out, "report"), { recursive: true });
  writeFileSync(join(out, "findings", "BUG-1", "report.yaml"), "id: BUG-1\n");
  writeFileSync(join(out, "knowledge", "worklog.md"), "bounded work\n");
  for (const name of ["completion.yaml", "audit-report.yaml", "summary.md"]) writeFileSync(join(out, "report", name), "stale\n");
  return { root, out, control };
}

function gate(command: "prepare" | "verify", f: ReturnType<typeof fixture>, extra: string[] = []) {
  return spawnSync("python3", [artifacts, command, "--out-dir", f.out, "--control-dir", f.control, ...extra], { encoding: "utf8" });
}

function validReports(out: string) {
  writeFileSync(join(out, "report", "completion.yaml"), "status: incomplete\nreason: 达到用户设定时长，结果可能不完整。\n");
  writeFileSync(join(out, "report", "audit-report.yaml"), [
    "report_version: '1'",
    "target:",
    "  project_name: fixture",
    "  project_root: .",
    "summary:",
    "  total_hypotheses: 0",
    "  done_hypotheses: 0",
    "  pending_hypotheses: 0",
    "  confirmed_findings: 0",
    "  refuted_hypotheses: 0",
    "findings: []",
    "limitations:",
    "  - time limit reached",
    "",
  ].join("\n"));
  writeFileSync(join(out, "report", "summary.md"), "# 有界收口\n");
}

describe("trusted deadline supervisor", () => {
  it("preserves natural child exits and reserves 124 for its own deadline", () => {
    expect(spawnSync("python3", [deadline, "--timeout", "2", "--", "sh", "-c", "exit 7"]).status).toBe(7);
    expect(spawnSync("python3", [deadline, "--timeout", "2", "--", "sh", "-c", "exit 137"]).status).toBe(137);
    const reserved = spawnSync("python3", [deadline, "--timeout", "2", "--", "sh", "-c", "exit 124"], { encoding: "utf8" });
    expect(reserved.status).toBe(125);
    expect(reserved.stderr).toContain('"event":"child_reserved_exit"');
    const timed = spawnSync("python3", [deadline, "--timeout", "0.1", "--grace", "0.1", "--", "sh", "-c", "sleep 30"], { encoding: "utf8" });
    expect(timed.status).toBe(124);
    expect(timed.stderr).toContain('"event":"deadline_reached"');
  });

  it("forwards external cancellation without reporting a deadline", async () => {
    const child = spawn("python3", [deadline, "--timeout", "10", "--grace", "0.2", "--", "sh", "-c", "trap 'exit 0' TERM; sleep 30"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill("SIGTERM");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    expect(result).toEqual({ code: 143, signal: null });
    expect(stderr).toContain('"event":"external_signal"');
    expect(stderr).not.toContain("deadline_reached");
  });
});

describe("scan timeout state machine", () => {
  it("clamps the finalization budget to 20%, 120..600 seconds", () => {
    const result = spawnSync("bash", ["-c", `source "$1"; calculate_finalize_budget 10; calculate_finalize_budget 1800; calculate_finalize_budget 99999`, "test", scanMode], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["120", "360", "600"]);
  });

  it("finalizes only trusted 124 and preserves crash/OOM exits", () => {
    const script = `
      source "$1"
      calls=0
      run_timeout_finalizer(){ calls=$((calls+1)); return "\${FINAL_RC:-0}"; }
      for code in 0 1 125 137; do
        set +e; handle_analysis_exit "$code" 100; rc=$?; set -e
        printf '%s:%s:%s\\n' "$code" "$rc" "$calls"
      done
      set +e; handle_analysis_exit 124 100; rc=$?; set -e
      printf '124:%s:%s\\n' "$rc" "$calls"
      FINAL_RC=9
      set +e; handle_analysis_exit 124 100; rc=$?; set -e
      printf '124-failed:%s:%s\\n' "$rc" "$calls"
    `;
    const result = spawnSync("bash", ["-c", script, "test", scanMode], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["0:0:0", "1:1:0", "125:125:0", "137:137:0", "124:0:1", "124-failed:9:2"]);
  });
});

describe("timeout finalization artifact gate", () => {
  it("removes stale report finals and accepts only new incomplete output without business mutations", () => {
    const f = fixture();
    const prepared = gate("prepare", f, ["--analysis-limit-seconds", "1800"]);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(statSync(f.control).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.control, "snapshot.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.control, "inventory.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(f.control, "inventory.json"), "utf8")).not.toContain(f.root);
    validReports(f.out);
    const verified = gate("verify", f);
    expect(verified.status, verified.stderr).toBe(0);
    const cleaned = spawnSync("python3", [artifacts, "cleanup", "--control-dir", f.control], { encoding: "utf8" });
    expect(cleaned.status, cleaned.stderr).toBe(0);
    expect(existsSync(f.control)).toBe(false);
  });

  it("deletes an old completion and requires a new non-stale fingerprint", () => {
    const f = fixture();
    writeFileSync(join(f.out, "report", "completion.yaml"), "status: complete\nreason: prior completed run\n");
    const oldFingerprint = fingerprintAuditCompletion(f.out);
    expect(oldFingerprint).not.toBeNull();
    const run = createAuditCompletionEngineRun("timeout-run", "2026-07-12T00:00:00Z", oldFingerprint);

    expect(gate("prepare", f, ["--analysis-limit-seconds", "1800"]).status).toBe(0);
    expect(evaluateAuditCompletion({ outDir: f.out, engineRun: run }).status).toBe("missing");
    validReports(f.out);
    expect(gate("verify", f).status).toBe(0);

    const fresh = fingerprintAuditCompletion(f.out);
    expect(fresh?.sha256).not.toBe(oldFingerprint?.sha256);
    expect(evaluateAuditCompletion({ outDir: f.out, engineRun: run })).toMatchObject({
      status: "incomplete",
      engine_status: "incomplete",
      error_code: null,
    });
  });

  it("rejects modified, added, or removed protected artifacts", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => writeFileSync(join(f.out, "findings", "BUG-1", "report.yaml"), "changed\n"),
      (f: ReturnType<typeof fixture>) => writeFileSync(join(f.out, "knowledge", "new.md"), "new\n"),
      (f: ReturnType<typeof fixture>) => rmSync(join(f.out, "knowledge", "worklog.md")),
    ]) {
      const f = fixture(); expect(gate("prepare", f, ["--analysis-limit-seconds", "10"]).status).toBe(0);
      mutate(f); validReports(f.out);
      expect(gate("verify", f).status).toBe(3);
    }
  });

  it("rejects complete/missing/extra report output and unsafe source entries", () => {
    const complete = fixture(); expect(gate("prepare", complete, ["--analysis-limit-seconds", "10"]).status).toBe(0);
    validReports(complete.out); writeFileSync(join(complete.out, "report", "completion.yaml"), "status: complete\nreason: done\n");
    expect(gate("verify", complete).status).toBe(3);

    const extra = fixture(); expect(gate("prepare", extra, ["--analysis-limit-seconds", "10"]).status).toBe(0);
    validReports(extra.out); writeFileSync(join(extra.out, "report", "extra.txt"), "x");
    expect(gate("verify", extra).status).toBe(3);

    const invented = fixture(); expect(gate("prepare", invented, ["--analysis-limit-seconds", "10"]).status).toBe(0);
    validReports(invented.out);
    const reportPath = join(invented.out, "report", "audit-report.yaml");
    writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace("findings: []", [
      "findings:",
      "  - id: BUG-R9-C9-A9-H9",
      "    title: Invented",
      "    severity: high",
      "    vulnerability_type: fabricated",
      "    location: src/x.c:1",
    ].join("\n")));
    expect(gate("verify", invented).status).toBe(3);

    const linked = fixture(); symlinkSync("worklog.md", join(linked.out, "knowledge", "link.md"));
    expect(gate("prepare", linked, ["--analysis-limit-seconds", "10"]).status).toBe(3);

    const hardlinked = fixture(); linkSync(join(hardlinked.out, "knowledge", "worklog.md"), join(hardlinked.out, "knowledge", "copy.md"));
    expect(gate("prepare", hardlinked, ["--analysis-limit-seconds", "10"]).status).toBe(3);

    const redirected = fixture();
    const victim = join(redirected.root, "victim"); mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
    symlinkSync(victim, redirected.control);
    const cleanup = spawnSync("python3", [artifacts, "cleanup", "--control-dir", redirected.control]);
    expect(cleanup.status).toBe(3);
    expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
  });
});
