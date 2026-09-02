import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWebSource = (path: string) => readFileSync(resolve(__dirname, "../src", path), "utf8");

/**
 * task-285df3a9: overview-tab "task configuration" card — creation-time
 * snapshot from source_meta + credential_label, read-only, zero new APIs.
 * Source-level pins (component renders under real i18n; value mapping logic
 * is inline and exercised by QA on 31.102 with real old/new tasks).
 */
describe("task config card (task-285df3a9)", () => {
  const tab = readWebSource("features/tasks/pages/tabs/OverviewTab.tsx");
  const zh = readWebSource("shared/i18n/zh.ts");
  const en = readWebSource("shared/i18n/en.ts");

  it("renders the card as the first card of the overview tab", () => {
    expect(tab).toContain('<TaskConfigCard task={task} />');
    expect(tab.indexOf('<TaskConfigCard task={task} />')).toBeLessThan(tab.indexOf('i18n.t("overview.projectProfile")'));
    expect(tab).toContain('data-testid="task-config-card"');
  });

  it("maps all five field groups from source_meta + top-level credential_label", () => {
    for (const probe of ["sm.filename", "sm.git_url", "sm.enable_poc", "sm.enable_exp", "sm.enable_chain", "sm.audit_focus", "sm.scan_timeout", "task.credential_label"]) {
      expect(tab).toContain(probe);
    }
  });

  it("missing single fields fall back to the KV em-dash; empty legacy meta shows the legacy line", () => {
    expect(tab).toContain("overview.configLegacy");
    expect(tab).toContain("hasAny");
    // KV renders null values as —
    expect(tab).toMatch(/value=\{sourceValue\}/);
    expect(tab).toMatch(/value=\{task\.credential_label \?\? null\}/);
  });

  it("scan timeout renders hours; missing → auto-default copy", () => {
    expect(tab).toContain("overview.configDefaultTimeout");
    expect(tab).toContain("overview.configHours");
  });

  it("ships zh + en copy for every config key", () => {
    for (const key of ["configCardTitle", "configSnapshotNote", "configLegacy", "configSource", "configDynamicVerify", "configDynamicExploit", "configDynamicChain", "configAuditFocus", "configScanTimeout", "configCredential", "configDefaultTimeout"]) {
      expect(zh).toContain(`"overview.${key}"`);
      expect(en).toContain(`"overview.${key}"`);
    }
    expect(zh).toContain('"common.on"');
    expect(en).toContain('"common.on"');
  });
});
