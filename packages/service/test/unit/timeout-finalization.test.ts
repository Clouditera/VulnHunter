import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Timeout handling after the LLM finalizer retirement (fish 2026-08-18):
 * the deadline runner (run-with-deadline.py) remains the executor and keeps
 * 124 reserved; scan-mode.sh turns 124 into the platform timeout marker
 * (.vulnhunter-timeout, JSON shape frozen) and exits 0 — a clean terminal
 * state, no second LLM flow, no finalizer assets.
 */

const repoRoot = join(import.meta.dirname, "../../../..");
const deadline = join(repoRoot, "worker-assets/run-with-deadline.py");
const scanMode = join(repoRoot, "worker-assets/scan-mode.sh");
const roots: string[] = [];

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

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

  it("waits for all process-group descendants before returning a deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "deadline-group-")); roots.push(root);
    const marker = join(root, "stopped");
    const shell = `trap 'exit 0' TERM; (trap 'sleep 0.2; echo stopped > "${marker}"; exit 0' TERM; while :; do sleep 1; done) & wait`;
    const result = spawnSync("python3", [deadline, "--timeout", "0.1", "--grace", "1", "--", "sh", "-c", shell], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(124);
    expect(readFileSync(marker, "utf8").trim()).toBe("stopped");
  });

  it("forwards external cancellation without reporting a deadline", async () => {
    const child = spawn("python3", [deadline, "--timeout", "10", "--grace", "0.2", "--", "sh", "-c", "trap 'exit 0' TERM; sleep 30"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    child.kill("SIGTERM");
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    expect(result).toEqual({ code: 143, signal: null });
    expect(stderr).toContain('"event":"external_signal"');
    expect(stderr).not.toContain("deadline_reached");
  });
});

describe("scan-mode timeout: 124 → platform marker → exit 0", () => {
  function runScanMode(env: Record<string, string>): { status: number | null; stderr: string } {
    // Drive the real scan-mode.sh with a fake youngflow that exits on demand.
    const root = mkdtempSync(join(tmpdir(), "scan-mode-timeout-")); roots.push(root);
    const fakeBin = join(root, "bin"); const { mkdirSyncSync } = { mkdirSyncSync: null } as never;
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(join(root, "work"), { recursive: true });
    const fakeYoungflow = join(fakeBin, "youngflow");
    fs.writeFileSync(fakeYoungflow, "#!/bin/sh\nexit 124\n");
    fs.chmodSync(fakeYoungflow, 0o755);
    const fakePi = join(fakeBin, "pi");
    fs.writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fakePi, 0o755);
    // scan-mode expects its assets at /opt — but we only run it via `main` with
    // stubs? Simpler: source the script functions is not viable post-rewrite;
    // run the real script with PATH pointing at fakes and the required files
    // present where the script looks.
    const result = spawnSync("bash", [scanMode], {
      encoding: "utf8",
      cwd: join(root, "work"),
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HOME: root,
        MODE: "scan",
        TASK_ID: "task-timeout-test",
        SCAN_TIMEOUT: "60",
        YOUNGFLOW_MAX_PARALLEL: "1",
        ...env,
      },
    });
    return { status: result.status, stderr: result.stderr ?? "" };
  }

  it("scan-mode.sh is syntactically valid and has no finalizer remnants", () => {
    const check = spawnSync("bash", ["-n", scanMode], { encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
    const text = readFileSync(scanMode, "utf8");
    expect(text).not.toContain("run_timeout_finalizer");
    expect(text).not.toContain("calculate_finalize_budget");
    expect(text).not.toContain("cleanup_finalize_control");
    expect(text).not.toContain("timeout-finalize-artifacts");
    expect(text).not.toContain("vulnforge-timeout");
    // The 124 → marker path must exist with the frozen JSON shape
    // (escaped quotes inside the printf string).
    expect(text).toContain(String.raw`{\"reason\":\"scan_timeout\",\"at\":\"`);
  });

  it("124 produces the marker and exit 0 (no finalizer assets needed)", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-mode-marker-")); roots.push(root);
    const src = readFileSync(scanMode, "utf8");
    // Extract the exact 124 block as shipped; retarget /workspace/out → fixture.
    const start = src.indexOf('if [ "$EXIT" -eq 124 ]; then');
    const end = src.indexOf("\nfi\n", start);
    expect(start).toBeGreaterThan(-1);
    let block = src.slice(start, end + 4);
    block = block.split("/workspace/out").join(root);
    const script = `set -e\nEXIT=124\n${block}\necho "final_exit=$EXIT"\n`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toContain("final_exit=0");
    const marker = join(root, ".vulnhunter-timeout");
    expect(existsSync(marker)).toBe(true);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.reason).toBe("scan_timeout");
    expect(typeof payload.at).toBe("string");
    expect(payload.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
