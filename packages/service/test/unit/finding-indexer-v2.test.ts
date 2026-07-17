import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listed: new Map<string, string[]>(),
  listErrors: new Set<string>(),
  yaml: new Map<string, string>(),
  rows: new Map<string, any>(),
  timestampUpdates: 0,
  warnings: [] as any[],
}));

function fakeDb(strings: TemplateStringsArray, ...values: any[]) {
  const sql = strings.join("?");
  if (sql.includes("SELECT tenant_id FROM tasks")) return Promise.resolve([{ tenant_id: "tenant-1" }]);
  if (sql.includes("UPDATE tasks SET findings_indexed_at")) {
    state.timestampUpdates++;
    return Promise.resolve([]);
  }
  if (sql.includes("INSERT INTO findings_meta")) {
    const taskId = values[0];
    const findingKey = values[2];
    const mapKey = `${taskId}:${findingKey}`;
    const previous = state.rows.get(mapKey);
    state.rows.set(mapKey, {
      id: previous?.id ?? `id-${findingKey}`,
      review_status: previous?.review_status ?? "pending",
      user_notes: previous?.user_notes ?? null,
      finding_key: findingKey,
      yaml_minio_key: values[3],
      severity: values[4],
      finding_class: values[22],
      poc_status: values[23],
      exp_status: values[24],
      affected_versions: values[25],
      item_type: values[26],
    });
    return Promise.resolve([]);
  }
  throw new Error(`Unexpected SQL: ${sql.slice(0, 80)}`);
}

vi.mock("../../src/infra/db/client.js", () => ({ getDb: () => fakeDb }));
vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({
    listObjects: (_bucket: string, prefix: string) => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        if (state.listErrors.has(prefix)) {
          emitter.emit("error", new Error("list failed"));
          return;
        }
        for (const name of state.listed.get(prefix) ?? []) emitter.emit("data", { name });
        emitter.emit("end");
      });
      return emitter;
    },
    getObject: async (_bucket: string, key: string) => {
      const raw = state.yaml.get(key);
      if (raw === undefined) throw new Error("missing object");
      return Readable.from([Buffer.from(raw)]);
    },
  }),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(),
    warn: vi.fn((fields: any) => state.warnings.push(fields)),
  },
}));

const {
  indexFindings,
  matchFindingObjectKey,
  normalizeFindingDynamicMeta,
  selectFindingCandidates,
} = await import("../../src/features/findings/indexer.js");

const taskId = "task-1";
const base = `scan-outputs/${taskId}/`;
const valid = (overrides = "") => `
metadata:
  title: Example
  finding_class: vulnerability
  poc_status: pending
  cvss_score: 7.5
  ${overrides}
`;

beforeEach(() => {
  state.listed.clear();
  state.listErrors.clear();
  state.yaml.clear();
  state.rows.clear();
  state.timestampUpdates = 0;
  state.warnings = [];
});

describe("VulnForge 2 finding matcher", () => {
  it("covers P01-P12 exact canonical, ignored nested, legacy and task scope", () => {
    expect(matchFindingObjectKey(taskId, `${base}findings/BUG-1/report.yaml`)).toMatchObject({
      findingKey: "BUG-1", itemType: "finding", sourceKind: "canonical_v2", priority: 400,
    });
    for (const key of [
      `${base}findings/BUG-1/poc/x.yaml`, `${base}findings/BUG-1/exp/x.yml`,
      `${base}findings/BUG-1/other.yaml`, `${base}findings/BUG-1/nested/report.yaml`,
      `${base}findings/BUG-1/report.yml`, `${base}findings/report.yaml`,
      `${base}findings/BUG-/report.yaml`, `${base}findings/bug-1/report.yaml`,
      `scan-outputs/other/findings/BUG-1/report.yaml`,
    ]) expect(matchFindingObjectKey(taskId, key)).toBeNull();
    expect(matchFindingObjectKey(taskId, `${base}findings/BUG-OLD.yaml`)).toMatchObject({ sourceKind: "legacy_finding", findingKey: "BUG-OLD" });
    expect(matchFindingObjectKey(taskId, `${base}raw_findings/legacy.yml`)).toMatchObject({ sourceKind: "legacy_raw", findingKey: "legacy" });
    expect(matchFindingObjectKey(taskId, `${base}risks/RISK-1.yaml`)).toMatchObject({ sourceKind: "legacy_risk", itemType: "risk" });
    expect(matchFindingObjectKey(taskId, `${base}findings/report.yaml`)).toBeNull();
  });

  it("selects canonical then priority and lexicographic winner deterministically", () => {
    const keys = [
      `${base}findings/BUG-1.yaml`, `${base}findings/BUG-1/report.yaml`,
      `${base}findings/SAME.yml`, `${base}findings/SAME.yaml`, `${base}risks/BUG-1.yaml`,
    ];
    const selected = selectFindingCandidates(keys.map((key) => matchFindingObjectKey(taskId, key)!).filter(Boolean));
    expect(selected.winners.map((item: any) => item.objectKey)).toEqual([
      `${base}findings/BUG-1/report.yaml`, `${base}findings/SAME.yaml`,
    ]);
    expect(selected.collisions).toHaveLength(3);
  });
});

describe("VulnForge 2 dynamic normalizer", () => {
  it("covers known/null/blank/future/type and affected_versions rules", () => {
    expect(normalizeFindingDynamicMeta({ finding_class: "risk", poc_status: "reproduced", exp_status: "confirmed", affected_versions: " >=1, <2 " }, true)).toEqual({
      finding_class: "risk", poc_status: "reproduced", exp_status: "confirmed", affected_versions: ">=1, <2", warnings: [],
    });
    const missing = normalizeFindingDynamicMeta({ finding_class: " ", poc_status: null, exp_status: undefined, affected_versions: "unknown" }, true);
    expect(missing).toMatchObject({ finding_class: null, poc_status: null, exp_status: null, affected_versions: "unknown" });
    expect(missing.warnings.map((warning: any) => warning.code)).toEqual([
      "WARN_FINDING_REQUIRED_FIELD_MISSING", "WARN_FINDING_REQUIRED_FIELD_MISSING",
    ]);
    const future = normalizeFindingDynamicMeta({ finding_class: "Future", poc_status: 3, exp_status: "future", affected_versions: ["1"] }, false);
    expect(future).toMatchObject({ finding_class: "unknown", poc_status: "unknown", exp_status: "unknown", affected_versions: null });
    expect(future.warnings.map((warning: any) => warning.code)).toEqual(expect.arrayContaining([
      "WARN_FINDING_ENUM_UNKNOWN", "WARN_FINDING_ENUM_INVALID_TYPE", "WARN_FINDING_AFFECTED_VERSIONS_INVALID_TYPE",
    ]));
    expect(future.warnings).toHaveLength(4);
    expect(JSON.stringify(future.warnings)).not.toContain("Future");
  });
});

describe("VulnForge 2 discovery/upsert isolation", () => {
  it("indexes distinct canonical parents, ignores nested, keeps risk path type and advances timestamp", async () => {
    const keys = [`${base}findings/BUG-1/report.yaml`, `${base}findings/BUG-2/report.yaml`, `${base}findings/BUG-1/poc/poc.yaml`];
    state.listed.set(`${base}findings/`, keys);
    state.listed.set(`${base}risks/`, [`${base}risks/RISK-1.yaml`]);
    state.yaml.set(keys[0]!, valid());
    state.yaml.set(keys[1]!, "metadata:\n  title: Risk-class finding\n  finding_class: risk\n  poc_status: pending\n");
    state.yaml.set(`${base}risks/RISK-1.yaml`, "metadata:\n  title: risk\n");
    expect(await indexFindings(taskId, "bucket")).toBe(3);
    expect([...state.rows.values()].map((row) => row.finding_key).sort()).toEqual(["BUG-1", "BUG-2", "RISK-1"]);
    expect(state.rows.get(`${taskId}:BUG-2`)).toMatchObject({ item_type: "finding", finding_class: "risk" });
    expect(state.rows.get(`${taskId}:RISK-1`)).toMatchObject({ item_type: "risk", finding_class: null });
    expect(state.timestampUpdates).toBe(1);
  });

  it("fails closed when findings discovery errors and never uses visible raw/risk objects", async () => {
    state.listErrors.add(`${base}findings/`);
    state.listed.set(`${base}raw_findings/`, [`${base}raw_findings/SAME.yaml`]);
    state.listed.set(`${base}risks/`, [`${base}risks/SAME.yaml`]);
    state.yaml.set(`${base}raw_findings/SAME.yaml`, valid());
    state.yaml.set(`${base}risks/SAME.yaml`, valid());
    expect(await indexFindings(taskId, "bucket")).toBe(0);
    expect(state.rows.size).toBe(0);
    expect(state.timestampUpdates).toBe(0);
    expect(state.warnings).toContainEqual(expect.objectContaining({ code: "WARN_FINDING_DISCOVERY_FAILED", prefix: "findings" }));
  });

  it("fails closed before upsert when risks discovery errors after findings success", async () => {
    const canonical = `${base}findings/BUG-1/report.yaml`;
    state.listed.set(`${base}findings/`, [canonical]);
    state.yaml.set(canonical, valid());
    state.listErrors.add(`${base}risks/`);
    expect(await indexFindings(taskId, "bucket")).toBe(0);
    expect(state.rows.size).toBe(0);
    expect(state.timestampUpdates).toBe(0);
    expect(state.warnings).toContainEqual(expect.objectContaining({ code: "WARN_FINDING_DISCOVERY_FAILED", prefix: "risks" }));
  });

  it("uses raw fallback when findings has only ignored nested objects", async () => {
    state.listed.set(`${base}findings/`, [`${base}findings/BUG-1/poc/x.yaml`]);
    state.listed.set(`${base}raw_findings/`, [`${base}raw_findings/legacy.yml`]);
    state.listed.set(`${base}risks/`, []);
    state.yaml.set(`${base}raw_findings/legacy.yml`, "vulnerability:\n  vuln_type: xss\n");
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.get(`${taskId}:legacy`)).toMatchObject({ item_type: "finding" });
  });

  it("does not fallback from malformed canonical, isolates valid keys and withholds timestamp", async () => {
    const canonicalBad = `${base}findings/BUG-BAD/report.yaml`;
    const legacySame = `${base}findings/BUG-BAD.yaml`;
    const canonicalGood = `${base}findings/BUG-GOOD/report.yaml`;
    state.listed.set(`${base}findings/`, [legacySame, canonicalBad, canonicalGood]);
    state.listed.set(`${base}risks/`, []);
    state.yaml.set(legacySame, valid());
    state.yaml.set(canonicalBad, "metadata: [unterminated");
    state.yaml.set(canonicalGood, valid("exp_status: future-status\n  affected_versions: ' 1.x '"));
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.has(`${taskId}:BUG-BAD`)).toBe(false);
    expect(state.rows.get(`${taskId}:BUG-GOOD`)).toMatchObject({ exp_status: "unknown", affected_versions: "1.x" });
    expect(state.timestampUpdates).toBe(0);
    expect(state.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "WARN_FINDING_SOURCE_COLLISION", "WARN_FINDING_INDEX_FAILED", "WARN_FINDING_ENUM_UNKNOWN", "WARN_FINDING_INDEX_PARTIAL",
    ]));
  });

  it("upsert switches flat→canonical, clears optional fields and preserves manual review", async () => {
    const legacy = `${base}findings/BUG-1.yaml`;
    state.listed.set(`${base}findings/`, [legacy]);
    state.listed.set(`${base}risks/`, []);
    state.yaml.set(legacy, valid("exp_status: confirmed\n  affected_versions: 1.x"));
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    const row = state.rows.get(`${taskId}:BUG-1`);
    row.review_status = "confirmed";
    row.user_notes = "keep me";

    const canonical = `${base}findings/BUG-1/report.yaml`;
    state.listed.set(`${base}findings/`, [canonical]);
    state.yaml.set(canonical, valid());
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.get(`${taskId}:BUG-1`)).toMatchObject({
      id: "id-BUG-1", yaml_minio_key: canonical, exp_status: null, affected_versions: null,
      review_status: "confirmed", user_notes: "keep me",
    });
    expect(state.rows.size).toBe(1);
  });
});

describe("VulnForge 1782ef6 enum/layout intake", () => {
  it("stores poc_status=not-needed verbatim (no CHECK collision, no unknown fallback)", async () => {
    const key = `${base}findings/BUG-R1/report.yaml`;
    state.listed.set(`${base}findings/`, [key]);
    state.listed.set(`${base}risks/`, []);
    state.yaml.set(key, "metadata:\n  title: Risk-class finding\n  finding_class: risk\n  poc_status: not-needed\n  exp_status: not-needed\n  cvss_score: 3.1\n");
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.get(`${taskId}:BUG-R1`)).toMatchObject({
      finding_class: "risk", poc_status: "not-needed", exp_status: "not-needed",
    });
    expect(state.warnings.filter((w) => w.code?.startsWith("WARN_FINDING_ENUM"))).toHaveLength(0);
    expect(state.timestampUpdates).toBe(1);
  });

  it("stores every frozen exp_status/poc_status enum value verbatim", async () => {
    const expValues = ["pending", "confirmed", "downgraded", "failed", "blocked", "not-needed", "unknown"];
    const pocValues = ["pending", "reproduced", "fail-reproduced", "blocked", "not-needed", "unknown"];
    const keys: string[] = [];
    expValues.forEach((value, i) => {
      const key = `${base}findings/BUG-E${i}/report.yaml`;
      keys.push(key);
      state.yaml.set(key, `metadata:\n  title: exp ${value}\n  finding_class: vulnerability\n  poc_status: ${pocValues[i] ?? "pending"}\n  exp_status: ${value}\n`);
    });
    state.listed.set(`${base}findings/`, keys);
    state.listed.set(`${base}risks/`, []);
    expect(await indexFindings(taskId, "bucket")).toBe(expValues.length);
    expValues.forEach((value, i) => {
      expect(state.rows.get(`${taskId}:BUG-E${i}`)).toMatchObject({ exp_status: value, poc_status: pocValues[i] ?? "pending" });
    });
    expect(state.warnings.filter((w) => w.code?.startsWith("WARN_FINDING_ENUM"))).toHaveLength(0);
  });

  it("terminal read locks ev-assess downgrade: re-index of rewritten report.yaml yields downgraded content", async () => {
    // No separate \"re-index\" mechanism exists: the indexer reads report.yaml
    // as-is at index time, so a terminal-state read after ev-assess rewrites
    // (downgrade CVSS/class/status in place) naturally stores the downgraded
    // version. This test locks that behavior against regression.
    const key = `${base}findings/BUG-9/report.yaml`;
    state.listed.set(`${base}findings/`, [key]);
    state.listed.set(`${base}risks/`, []);
    state.yaml.set(key, "metadata:\n  title: Inflated RCE claim\n  finding_class: vulnerability\n  poc_status: reproduced\n  exp_status: pending\n  cvss_score: 9.1\n");
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.get(`${taskId}:BUG-9`)).toMatchObject({
      severity: "high", finding_class: "vulnerability", poc_status: "reproduced", exp_status: "pending",
    });

    // ev-assess rewrites the same report.yaml before flow end (downgrade).
    state.yaml.set(key, "metadata:\n  title: Downgraded to hardening gap\n  finding_class: risk\n  poc_status: not-needed\n  exp_status: downgraded\n  cvss_score: 3.4\n");
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.get(`${taskId}:BUG-9`)).toMatchObject({
      severity: "low", finding_class: "risk", poc_status: "not-needed", exp_status: "downgraded",
    });
    expect(state.rows.size).toBe(1);
  });

  it("keeps unknown-fallback for future engine enum values", async () => {
    const key = `${base}findings/BUG-F1/report.yaml`;
    state.listed.set(`${base}findings/`, [key]);
    state.listed.set(`${base}risks/`, []);
    state.yaml.set(key, "metadata:\n  title: Future\n  finding_class: vulnerability\n  poc_status: future-poc-state\n  exp_status: future-exp-state\n");
    expect(await indexFindings(taskId, "bucket")).toBe(1);
    expect(state.rows.get(`${taskId}:BUG-F1`)).toMatchObject({ poc_status: "unknown", exp_status: "unknown" });
    expect(state.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["WARN_FINDING_ENUM_UNKNOWN"]));
  });
});
