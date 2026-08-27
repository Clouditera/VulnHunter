// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * HALL-23: artifact download URL builders + UI entry points.
 * Part 1 exercises the pure builders (exact endpoint + encoding contracts).
 * Part 2 pins the source-level wiring of the entry points (href/download
 * anchors) in FindingDynamicCards / ExploitsTab / OverviewTab, following the
 * repo's source-contract test convention (see confirm-dialog.test.ts).
 */
const { api } = await import("../src/shared/api/client.js");

const readWebSource = (path: string) => readFileSync(resolve(__dirname, "../src", path), "utf8");

describe("artifact download URL builders (HALL-23)", () => {
  it("single-file download URL encodes the path exactly once", () => {
    expect(api.tasks.artifactFileDownloadUrl("t1", "findings/BUG-1/poc/poc.md")).toBe(
      "/api/tasks/t1/artifacts/file/download?path=findings%2FBUG-1%2Fpoc%2Fpoc.md",
    );
    expect(api.tasks.artifactFileDownloadUrl("t1", "exploits/EXP-9/中文.md")).toBe(
      `/api/tasks/t1/artifacts/file/download?path=${encodeURIComponent("exploits/EXP-9/中文.md")}`,
    );
  });

  it("finding/exploit/task archive URLs encode their ids", () => {
    expect(api.tasks.findingArtifactsDownloadUrl("t1", "BUG-42")).toBe(
      "/api/tasks/t1/findings/BUG-42/artifacts/download",
    );
    expect(api.tasks.exploitArtifactsDownloadUrl("t1", "EXP-7")).toBe(
      "/api/tasks/t1/exploits/EXP-7/artifacts/download",
    );
    expect(api.tasks.archiveDownloadUrl("t1")).toBe("/api/tasks/t1/artifacts/archive");
  });
});

describe("FindingDynamicCards download entries (HALL-23)", () => {
  const src = readWebSource("features/tasks/components/FindingDynamicCards.tsx");

  it("every accordion file row links the single-file download endpoint", () => {
    expect(src).toMatch(/artifactFileDownloadUrl/);
    // anchor with download attr inside the accordion head row
    expect(src).toContain("data-testid={`finding-artifact-download-${basename}`}");
    // download link must exist for non-previewable (binary) rows too — do not
    // gate it behind f.previewable
    expect(src).not.toMatch(/f\.previewable && <a/);
  });

  it("accordion head carries a per-finding pack-download anchor", () => {
    expect(src).toMatch(/findingArtifactsDownloadUrl/);
    expect(src).toMatch(/data-testid="finding-artifacts-download-btn"/);
  });
});

describe("ExploitsTab download entries (HALL-23)", () => {
  const src = readWebSource("features/tasks/pages/tabs/ExploitsTab.tsx");

  it("companion file rows link single-file download; chain gets pack download", () => {
    expect(src).toMatch(/artifactFileDownloadUrl/);
    expect(src).toMatch(/exploitArtifactsDownloadUrl/);
    expect(src).toMatch(/data-testid="exploit-artifacts-download-btn"/);
  });
});

describe("OverviewTab download-all entry (HALL-23)", () => {
  const src = readWebSource("features/tasks/pages/tabs/OverviewTab.tsx");

  it("offers the task-wide artifact archive, distinct from the source archive", () => {
    expect(src).toMatch(/archiveDownloadUrl/);
    expect(src).toMatch(/data-testid="overview-download-all-artifacts"/);
  });
});

describe("i18n keys for artifact downloads exist in both catalogs (HALL-23)", () => {
  const zh = readWebSource("shared/i18n/zh.ts");
  const en = readWebSource("shared/i18n/en.ts");
  const keys = [
    "finding.cards.downloadFile",
    "finding.cards.downloadAll",
    "expPage.downloadFile",
    "expPage.downloadAll",
    "overview.downloadAllArtifacts",
  ];

  it.each(keys)("%s present in zh + en", (key) => {
    expect(zh).toContain(`"${key}"`);
    expect(en).toContain(`"${key}"`);
  });
});
