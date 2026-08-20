import { describe, expect, it } from "vitest";
import { parseGateYaml, parseGateYamlLenient } from "../../src/features/prepare/contract.js";

/** The exact prod 55fb9cec breakage: unquoted detail containing "colon+space"
 * makes the whole document invalid YAML (js-yaml: nested mappings). */
const PROD_BREAKAGE = `next: continue
reason: complete
sandbox_type: base-linux
detail: Sonic v0.2.3 (Tauri 2 desktop workstation, studio.eternia.sonic) is a complete production application: Rust core (~8.7K LOC, 50+ IPC commands registered in lib.rs), React 19/TS frontend, full config set (Cargo.toml/lock, package.json/lock, tauri.conf.json, capabilities), yt-dlp sidecar + ffmpeg engine + signed updater. Profiler, wiki (index/overview/threat-model) and build environment record written; sandbox base-linux applied and reachable.
`;

const VALID = `next: end
reason: partial_source
detail: >
  缺少入口与业务逻辑：仅 tests/ 与 docs/，无基础应用。
sandbox_type: null
`;

describe("parseGateYamlLenient (task-c4b8730c)", () => {
  it("strict-valid files pass through unrecovered", () => {
    const res = parseGateYamlLenient(VALID);
    expect(res?.recovered).toBe(false);
    expect(res?.gate).toMatchObject({ next: "end", reason: "partial_source" });
  });

  it("prod breakage (unquoted detail): strict null, lenient recovers next=continue + reason", () => {
    expect(parseGateYaml(PROD_BREAKAGE)).toBeNull();
    const res = parseGateYamlLenient(PROD_BREAKAGE);
    expect(res?.recovered).toBe(true);
    expect(res?.gate).toEqual({ next: "continue", reason: "complete", detail: undefined, sandbox_type: null });
  });

  it("next=end with unrecoverable reason stays null (fail-closed: never guess a failure verdict)", () => {
    expect(parseGateYamlLenient("next: end\nreason: oops-bad-reason\ndetail: >\n  x\n")).toBeNull();
  });

  it("next=continue with unrecoverable reason recovers as complete (evidence gate still applies)", () => {
    const res = parseGateYamlLenient("next: continue\nreason: nope\ndetail: >\n  x\n");
    expect(res?.gate).toMatchObject({ next: "continue", reason: "complete" });
  });

  it("pure garbage stays null", () => {
    expect(parseGateYamlLenient("total garbage !!!\n[[[\n")).toBeNull();
    expect(parseGateYamlLenient("")).toBeNull();
  });
});
