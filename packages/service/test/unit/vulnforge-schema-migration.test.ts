import { describe, expect, it } from "vitest";

const migration = await import("../../../../scripts/ops/vulnforge-schema-migration.mjs");
const { affectedRefsFromManifestItems, findingKeyFromObjectKey, isLegacyFindingYaml, isLegacyWithoutLocation, migrateYamlDocument } = migration;

describe("vulnforge-schema-migration", () => {
  it("derives exact affected DB refs from manifest object keys", () => {
    expect(findingKeyFromObjectKey("scan-outputs/t1/risks/RISK-1.yaml")).toBe("RISK-1");
    expect(affectedRefsFromManifestItems([
      { originalKey: "scan-outputs/t1/findings/BUG-1.yaml", taskId: "t1", itemType: "finding" },
      { originalKey: "scan-outputs/t1/risks/RISK-1.yml", taskId: "t1", itemType: "risk", findingKey: "CUSTOM" },
    ])).toEqual([
      { yamlMinioKey: "scan-outputs/t1/findings/BUG-1.yaml", taskId: "t1", findingKey: "BUG-1", itemType: "finding" },
      { yamlMinioKey: "scan-outputs/t1/risks/RISK-1.yml", taskId: "t1", findingKey: "CUSTOM", itemType: "risk" },
    ]);
  });

  it("detects legacy schema by location fields without anchors", () => {
    expect(isLegacyFindingYaml({ metadata: { severity: "high", file_path: "a.c", line_number: 1 } })).toBe(true);
    expect(isLegacyFindingYaml({ metadata: { severity: "high", anchors: [{ file_path: "a.c", line: 1 }] } })).toBe(false);
    expect(isLegacyFindingYaml({ metadata: { severity: "high" } })).toBe(false);
    expect(isLegacyFindingYaml({ metadata: { title: "no location" } })).toBe(false);
    expect(isLegacyFindingYaml({ metadata: { severity: "medium" }, description: "legacy string" })).toBe(true);
  });

  it("migrates legacy location fields into anchors[0] and preserves critical severity", () => {
    const input = {
      metadata: {
        title: "critical legacy finding",
        severity: "critical",
        file_path: "src/app.py",
        line_number: "220",
        function: "run",
        cvss_score: 9.8,
      },
      description: "legacy description",
    };
    const result = migrateYamlDocument(input);
    expect(result.changed).toBe(true);
    expect(result.doc.metadata.anchors).toEqual([{ file_path: "src/app.py", line: 220, function: "run" }]);
    expect(result.doc.metadata.severity).toBe("critical");
    expect(result.doc.metadata.schema_migrated).toBeUndefined();
    expect(result.doc.description).toEqual({ detailed_description: "legacy description" });
  });

  it("maps data_flow/remediation/attack to new detail buckets", () => {
    const result = migrateYamlDocument({
      metadata: { severity: "medium", file_path: "a.c", line_number: 10 },
      description: { detailed_description: "detail", entry_point: "route", taint_source: "input", trigger_condition: "x" },
      data_flow: [
        { location: "a.c:10", description: "source" },
        "sink",
      ],
      remediation: "fix it",
      attack: { payload: "x" },
    });
    expect(result.changed).toBe(true);
    expect(result.doc.description.detailed_description).toBe("detail");
    expect(result.doc.description.entry_point).toBe("route");
    expect(result.doc.description.taint_source).toBe("input");
    expect(result.doc.description.trigger_condition).toBe("x");
    expect(result.doc.description.attack_description).toContain("payload");
    expect(result.doc.code.dataflow).toEqual([
      { step: 1, location: "a.c:10", description: "source" },
      { step: 2, description: "sink" },
    ]);
    expect(result.doc.code.fix_code).toBe("fix it");
    expect(result.doc.data_flow).toBeUndefined();
    expect(result.doc.remediation).toBeUndefined();
    expect(result.doc.attack).toBeUndefined();
  });

  it("is idempotent once anchors exist and does not wrap twice", () => {
    const migrated = migrateYamlDocument({ metadata: { severity: "medium", file_path: "a.c", line_number: 10 }, description: "x" });
    const rerun = migrateYamlDocument(migrated.doc);
    expect(rerun.changed).toBe(false);
    expect(rerun.doc).toEqual(migrated.doc);
  });

  it("handles partial legacy location without crashing", () => {
    const result = migrateYamlDocument({ metadata: { severity: "low", file_path: "b.c", line_number: "bad" } });
    expect(result.changed).toBe(true);
    expect(result.doc.metadata.anchors).toEqual([{ file_path: "b.c" }]);
  });

  it("does not treat severity-only records as migratable legacy", () => {
    const doc = { metadata: { severity: "info" } };
    expect(isLegacyFindingYaml(doc)).toBe(false);
    expect(isLegacyWithoutLocation(doc)).toBe(false);
    expect(migrateYamlDocument(doc).changed).toBe(false);
  });

  it("migrates no-location legacy detail once and is idempotent without marker", () => {
    const migrated = migrateYamlDocument({ metadata: { severity: "info" }, description: "legacy string" });
    expect(migrated.changed).toBe(true);
    expect(migrated.doc.metadata.anchors).toBeUndefined();
    expect(migrated.doc.description).toEqual({ detailed_description: "legacy string" });
    expect(isLegacyWithoutLocation(migrated.doc)).toBe(false);
    expect(isLegacyFindingYaml(migrated.doc)).toBe(false);
    expect(migrateYamlDocument(migrated.doc).changed).toBe(false);
  });
});
