import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

const reportMode = readFileSync(
  resolve(import.meta.dirname, "../../../../worker-assets/report-mode.sh"),
  "utf8",
);
const defaultSkill = readFileSync(
  resolve(import.meta.dirname, "../../../../flows/vulnhunter-report/skills/default-report-skill/SKILL.md"),
  "utf8",
);
const workerDockerfile = readFileSync(
  resolve(import.meta.dirname, "../../../../deploy/dockerfiles/worker.Dockerfile"),
  "utf8",
);

describe("builtin default report skill + toolchain", () => {
  it("report-mode.sh falls back to default-report-skill", () => {
    expect(reportMode).toContain("default-report-skill");
    expect(reportMode).toContain("No uploaded skill");
    expect(reportMode).toMatch(/cp -r .*default-report-skill.*uploaded-report-skill/);
  });

  it("default SKILL.md declares md/docx/xlsx", () => {
    expect(defaultSkill).toMatch(/security-report\.md/);
    expect(defaultSkill).toMatch(/pandoc/);
    expect(defaultSkill).toMatch(/openpyxl/);
    expect(defaultSkill).toMatch(/docx/i);
    expect(defaultSkill).toMatch(/xlsx/i);
  });

  it("worker image installs pandoc + openpyxl", () => {
    expect(workerDockerfile).toMatch(/\bpandoc\b/);
    expect(workerDockerfile).toMatch(/openpyxl/);
  });
});
