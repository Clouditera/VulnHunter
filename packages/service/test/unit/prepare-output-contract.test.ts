import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * task-b451d2e9: prepare flow wires output-contract with prepare-owned rules.
 * Build-time copies extension from vulnforge; this test pins the repo-side
 * artifacts that Dockerfile overlays/probes.
 */

const root = resolve(__dirname, "../../../../");

describe("prepare output-contract wiring (task-b451d2e9)", () => {
  it("prepare-owned contracts.json targets prepare-result.json + schema", () => {
    const p = resolve(root, "flows/prepare/extensions/output-contract/contracts.json");
    expect(existsSync(p)).toBe(true);
    const c = JSON.parse(readFileSync(p, "utf8"));
    expect(c.prepare).toBeTruthy();
    expect(c.prepare.strict).toBe(true);
    expect(c.prepare.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: "prepare-result.json",
          schema: "schemas/prepare-result-v1.schema.json",
          min_count: 1,
        }),
      ]),
    );
  });

  it("prepare-result schema exists and requires three fields", () => {
    const p = resolve(root, "flows/prepare/schemas/prepare-result-v1.schema.json");
    const s = JSON.parse(readFileSync(p, "utf8"));
    expect(s.required).toEqual(
      expect.arrayContaining(["project_complete", "sandbox_type", "reason"]),
    );
  });

  it("flow.prepare.yaml lists output-contract on prepare stage", () => {
    const yaml = readFileSync(resolve(root, "flows/prepare/flow.prepare.yaml"), "utf8");
    expect(yaml).toMatch(/extensions:\s*\[[^\]]*output-contract/);
  });

  it("prepare-mode writes result under runtime output-dir (contract-visible)", () => {
    const sh = readFileSync(resolve(root, "worker-assets/prepare-mode.sh"), "utf8");
    expect(sh).toMatch(/result_path="\$runtime\/prepare-result\.json"/);
    expect(sh).toMatch(/final_result_path="\$PREPARE_OUTPUT_DIR\/prepare-result\.json"/);
    expect(sh).toMatch(/cp -p -- "\$result_path" "\$final_result_path"/);
  });

  it("worker Dockerfile overlays prepare contracts after vulnforge copy", () => {
    const df = readFileSync(resolve(root, "deploy/dockerfiles/worker.Dockerfile"), "utf8");
    expect(df).toMatch(/vulnforge\/extensions\/output-contract/);
    expect(df).toMatch(/prepare\/extensions\/output-contract/);
    expect(df).toMatch(/prepare-output-contract\.contracts\.json/);
    // Probe that the overlaid contracts.json still contains the prepare stage key.
    expect(df.includes("prepare/extensions/output-contract/contracts.json")).toBe(true);
    expect(df.includes('"prepare"')).toBe(true);
  });
});
