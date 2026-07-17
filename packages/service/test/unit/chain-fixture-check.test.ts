import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChainReport } from "../../src/features/artifacts/artifacts.js";

// Contract A.4 transitional fixture: a fabricated three-step chain (IDOR →
// credential leak → RCE) standing in until the two real-model E2E runs produce
// genuine chain artifacts. Validates against the real backend parser so the
// EXP page's data shape stays honest.
describe("EXP chain-report schema fixture (contract A.4)", () => {
  it("parses a valid three-step chain and projects the four sections", () => {
    const proj = parseChainReport(readFileSync(join(__dirname, "../fixtures/exp-chain/report.yaml"), "utf8"));
    expect(proj.title).toContain("RCE");
    expect(proj.members).toEqual(["BUG-IDOR-1", "BUG-CRED-2", "BUG-RCE-3"]);
    expect(proj.ev_priority).toBe("P1");
    expect(proj.combined_impact).toBeTruthy();
    expect(proj.chain).toHaveLength(3);
    expect(proj.chain[0]).toMatchObject({ step: 1, finding: "BUG-IDOR-1", role: "越权读取" });
    expect(proj.chain.every((s) => s.evidence)).toBe(true);
  });
});
