import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../..");
const roots: string[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prepare-owner-")); roots.push(root);
  const source = join(root, "source"), control = join(root, "control"), output = join(root, "output"), bin = join(root, "bin");
  mkdirSync(source); mkdirSync(control); mkdirSync(bin);
  writeFileSync(join(source, "README.md"), "readonly\n"); chmodSync(source, 0o555);
  const planner = join(control, "planner.json"); writeFileSync(planner, "{}", { mode: 0o600 });
  const original = readFileSync(join(repoRoot, "worker-assets/prepare-mode.sh"), "utf8");
  const script = join(root, "prepare-mode.sh");
  writeFileSync(script, original.replace("export PATH=/usr/local/bin:/usr/bin:/bin", `export PATH=${bin}:/usr/bin:/bin`), { mode: 0o755 });
  const fake = `#!/bin/sh
set -eu
mkdir -p "$PREPARE_CONTROL_DIR/.youngflow/checkpoints" "$PREPARE_OUTPUT_DIR"
printf 'checkpoint\\n' > "$PREPARE_CONTROL_DIR/.youngflow/checkpoints/flow_state.yaml"
printf 'receipt\\n' > "$PREPARE_CONTROL_DIR/receipt.json"
printf '{"ok":true}\\n' > "$PREPARE_OUTPUT_DIR/assessment-plan.json"
chmod 600 "$PREPARE_OUTPUT_DIR/assessment-plan.json" "$PREPARE_CONTROL_DIR/receipt.json"
case "\${FAKE_MODE:-success}" in
  success) exit 0 ;;
  failure) exit 1 ;;
  hold-success|hold-failure)
    : > "$FAKE_READY"
    trap 'exit 143' TERM HUP INT
    while [ ! -e "$FAKE_RELEASE" ]; do sleep 0.02; done
    [ "$FAKE_MODE" = hold-success ] && exit 0 || exit 1 ;;
  mismatch)
    printf '00000000-0000-0000-0000-000000000000\\n' > "$PREPARE_CONTROL_DIR/.prepare-owner/identity"
    chmod 600 "$PREPARE_CONTROL_DIR/.prepare-owner/identity"
    exit 1 ;;
  mismatch-after-output)
    mkdir "$PREPARE_OUTPUT_DIR/000-trigger" "$PREPARE_OUTPUT_DIR/zzz-slow"
    i=0; while [ "$i" -lt 5000 ]; do : > "$PREPARE_OUTPUT_DIR/zzz-slow/item-$i"; i=$((i + 1)); done
    (
      while [ -e "$PREPARE_OUTPUT_DIR/000-trigger" ]; do :; done
      printf '00000000-0000-0000-0000-000000000000\\n' > "$PREPARE_CONTROL_DIR/.prepare-owner/identity"
      chmod 600 "$PREPARE_CONTROL_DIR/.prepare-owner/identity"
    ) &
    exit 1 ;;
  *) exit 2 ;;
esac
`;
  writeFileSync(join(bin, "youngflow"), fake, { mode: 0o755 });
  const env = { ...process.env, PREPARE_SOURCE_ROOT: source, PREPARE_CONTROL_DIR: control, PREPARE_OUTPUT_DIR: output, PREPARE_PLANNER_INPUT: planner, PREPARE_MANIFEST_SCHEMA: "/trusted/manifest.json", PREPARE_PLAN_SCHEMA: "/trusted/plan.yaml", FAKE_READY: join(root, "ready"), FAKE_RELEASE: join(root, "release") } as NodeJS.ProcessEnv;
  return { root, source, control, output, planner, script, env };
}

function run(f: ReturnType<typeof fixture>, mode: string) {
  return spawnSync("/bin/sh", [f.script], { env: { ...f.env, FAKE_MODE: mode }, encoding: "utf8", timeout: 10_000 });
}
function start(f: ReturnType<typeof fixture>, mode: string): ChildProcess {
  return spawn("/bin/sh", [f.script], { env: { ...f.env, FAKE_MODE: mode }, stdio: "ignore" });
}
async function waitFor(path: string) { for (let i = 0; i < 250; i++) { if (existsSync(path)) return; await sleep(20); } throw new Error(`timeout: ${path}`); }
async function exited(child: ChildProcess): Promise<number | null> { return new Promise((resolve) => child.once("exit", (code) => resolve(code))); }
function digest(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function snapshot(root: string): Record<string, unknown> {
  if (!existsSync(root)) return {};
  const out: Record<string, unknown> = {};
  const walk = (dir: string, prefix = "") => { for (const name of readdirSync(dir).sort()) { const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name, st = statSync(path); out[rel] = [st.mode & 0o777, st.mtimeMs, st.isFile() ? digest(path) : "dir"]; if (st.isDirectory()) walk(path, rel); } };
  walk(root); return out;
}
function expectEmpty(path: string) { expect(existsSync(path) ? readdirSync(path) : []).toEqual([]); }

afterEach(() => { while (roots.length) { const root = roots.pop()!; try { chmodSync(join(root, "source"), 0o755); } catch {} rmSync(root, { recursive: true, force: true }); } });

describe("prepare-mode owner-bound lifecycle", () => {
  it("keeps final output on normal owner success and releases owner last", () => {
    const f = fixture(), result = run(f, "success"); expect(result.status, result.stderr).toBe(0);
    expectEmpty(f.control); const plan = join(f.output, "assessment-plan.json"); expect(digest(plan)).toBeTruthy(); expect(statSync(plan).mode & 0o777).toBe(0o600);
  });
  it("cleans only owned state on owner failure", () => {
    const f = fixture(), result = run(f, "failure"); expect(result.status).not.toBe(0); expectEmpty(f.control); expectEmpty(f.output);
  });
  it.each(["SIGTERM", "SIGHUP", "SIGINT"] as const)("stops child and cleans owned state on %s", async (signal) => {
    const f = fixture(), child = start(f, "hold-success"); await waitFor(f.env.FAKE_READY!); child.kill(signal); expect(await exited(child)).not.toBe(0); expectEmpty(f.control); expectEmpty(f.output);
  });
  it("active duplicate cannot mutate owner state and owner still succeeds", async () => {
    const f = fixture(), primary = start(f, "hold-success"); await waitFor(f.env.FAKE_READY!);
    const controlBefore = snapshot(f.control), outputBefore = snapshot(f.output); const duplicate = run(f, "success");
    expect(duplicate.status).toBe(3); expect(snapshot(f.control)).toEqual(controlBefore); expect(snapshot(f.output)).toEqual(outputBefore);
    writeFileSync(f.env.FAKE_RELEASE!, "release"); expect(await exited(primary)).toBe(0); expectEmpty(f.control); expect(statSync(join(f.output, "assessment-plan.json")).mode & 0o777).toBe(0o600);
  });
  it("post-success duplicate removes only its marker and preserves result bytes/mode/mtime", () => {
    const f = fixture(); expect(run(f, "success").status).toBe(0); const before = snapshot(f.output); expect(run(f, "success").status).toBe(3); expect(snapshot(f.output)).toEqual(before); expectEmpty(f.control);
  });
  it("preexisting and stale owner state are never taken over or deleted", () => {
    const preexisting = fixture(); mkdirSync(join(preexisting.control, ".youngflow")); writeFileSync(join(preexisting.control, ".youngflow/state"), "stale"); const before = snapshot(preexisting.control); expect(run(preexisting, "success").status).toBe(3); expect(snapshot(preexisting.control)).toEqual(before);
    const stale = fixture(); mkdirSync(join(stale.control, ".prepare-owner")); writeFileSync(join(stale.control, ".prepare-owner/identity"), "00000000-0000-0000-0000-000000000000\n", { mode: 0o600 }); const staleBefore = snapshot(stale.control); expect(run(stale, "success").status).toBe(3); expect(snapshot(stale.control)).toEqual(staleBefore);
  });
  it("rejects an existing control symlink without changing its target", () => {
    const f = fixture(), target = join(f.root, "control-target");
    rmSync(f.control, { recursive: true }); mkdirSync(target); writeFileSync(join(target, "planner.json"), "{}", { mode: 0o600 }); writeFileSync(join(target, "sentinel"), "unchanged", { mode: 0o640 }); symlinkSync(target, f.control);
    const targetStat = statSync(target), before = snapshot(target); expect(run(f, "success").status).toBe(3); expect(snapshot(target)).toEqual(before); expect(statSync(target).mode).toBe(targetStat.mode); expect(statSync(target).mtimeMs).toBe(targetStat.mtimeMs); expect(lstatSync(f.control).isSymbolicLink()).toBe(true);
  });
  it("rejects dangling output symlink and removes only its matching marker", () => {
    const f = fixture(), missingTarget = join(f.root, "missing-output-target"); symlinkSync(missingTarget, f.output); const before = snapshot(f.control);
    expect(run(f, "success").status).toBe(3); expect(snapshot(f.control)).toEqual(before); expect(lstatSync(f.output).isSymbolicLink()).toBe(true);
  });
  it("owner-bound init failure cleans marker instead of leaking ownership", () => {
    const f = fixture(), blocker = join(f.root, "output-parent"); writeFileSync(blocker, "blocker", { mode: 0o640 }); f.env.PREPARE_OUTPUT_DIR = join(blocker, "child");
    expect(run(f, "success").status).not.toBe(0); expectEmpty(f.control); expect(readFileSync(blocker, "utf8")).toBe("blocker");
  });
  it("identity mismatch before cleanup preserves all evidence", () => {
    const f = fixture(), result = run(f, "mismatch"); expect(result.status).not.toBe(0); expect(readdirSync(f.control)).toContain(".prepare-owner"); expect(readdirSync(f.output)).toContain("assessment-plan.json");
  });
  it("identity mismatch after output cleanup preserves control checkpoint", () => {
    const f = fixture(), result = run(f, "mismatch-after-output"); expect(result.status).not.toBe(0); expectEmpty(f.output);
    expect(readFileSync(join(f.control, ".youngflow/checkpoints/flow_state.yaml"), "utf8")).toBe("checkpoint\n"); expect(readdirSync(f.control)).toContain(".prepare-owner");
  });
  it("release-last stress lets the next owner finish without prior cleanup deleting it", async () => {
    for (let i = 0; i < 12; i++) {
      const f = fixture(), primary = start(f, "hold-failure"); await waitFor(f.env.FAKE_READY!);
      let winner: ReturnType<typeof spawnSync> | undefined;
      const contenders = (async () => {
        for (let n = 0; n < 1000 && existsSync(join(f.control, ".prepare-owner")); n++) await sleep(1);
        writeFileSync(f.planner, "{}", { mode: 0o600 });
        winner = run(f, "success");
      })();
      writeFileSync(f.env.FAKE_RELEASE!, "release"); expect(await exited(primary)).not.toBe(0); await contenders;
      expect(winner?.status).toBe(0); expectEmpty(f.control); expect(statSync(join(f.output, "assessment-plan.json")).mode & 0o777).toBe(0o600);
      chmodSync(f.source, 0o755); rmSync(f.root, { recursive: true, force: true }); roots.splice(roots.indexOf(f.root), 1);
    }
  }, 30_000);
});
