#!/usr/bin/env node
/*
 * VulnForge Phase 2 one-time YAML migration.
 *
 * Converts legacy findings/risks YAML under MinIO scan output finding/risk
 * directories to the new anchor-based schema. Supports inventory/dry-run/apply/restore.
 *
 * Safe defaults:
 *   - default mode is dry-run (no writes)
 *   - apply creates a MinIO backup manifest and copies original YAML first
 *   - apply rewrites MinIO YAML, then reindexes affected tasks when service dist is available
 *   - restore copies backed-up YAML back and restores backed-up findings_meta rows
 *
 * Intended runtime: inside vulnhunter-service container or an equivalent env with
 * MINIO_* and DATABASE_URL configured.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));

function makeServiceRequire() {
  const candidates = [
    process.env.SERVICE_PACKAGE_JSON,
    resolve(process.cwd(), "packages/service/package.json"),
    resolve(scriptDir, "../../packages/service/package.json"),
    "/app/packages/service/package.json",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return createRequire(pathToFileURL(candidate));
  }
  return require;
}

const serviceRequire = makeServiceRequire();

function requireRuntimePackage(name) {
  try { return require(name); } catch {
    return serviceRequire(name);
  }
}

export function parseArgs(argv) {
  const args = {
    mode: "dry-run",
    backupPrefix: "",
    restorePrefix: "",
    taskIds: [],
    limit: 0,
    reindex: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i];
    else if (a === "--backup-prefix") args.backupPrefix = argv[++i];
    else if (a === "--restore-prefix") args.restorePrefix = argv[++i];
    else if (a === "--task-id") args.taskIds.push(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i] || 0);
    else if (a === "--no-reindex") args.reindex = false;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return args;
}

export function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function asPositiveInt(v) {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function hasAnchors(doc) {
  return Array.isArray(doc?.metadata?.anchors) && doc.metadata.anchors.length > 0;
}

function hasLegacyLocation(m) {
  return m?.file_path != null || m?.line_number != null || m?.function != null;
}

function hasLegacyDetailBuckets(doc) {
  return typeof doc?.description === "string" || doc?.data_flow != null || doc?.remediation != null || doc?.attack != null;
}

export function isLegacyFindingYaml(doc) {
  const m = doc?.metadata;
  if (!isPlainObject(m)) return false;
  if (hasAnchors(doc)) return false;
  // Do not treat severity alone as migratable legacy structure. This keeps
  // no-location/no-legacy-detail records from being counted/written forever.
  return hasLegacyLocation(m) || hasLegacyDetailBuckets(doc);
}

export function isLegacyWithoutLocation(doc) {
  const m = doc?.metadata;
  if (!isPlainObject(m) || hasAnchors(doc)) return false;
  return !hasLegacyLocation(m) && isLegacyFindingYaml(doc);
}

function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

function stringifyBlock(v) {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function normalizeDataflow(dataFlow) {
  if (dataFlow == null) return undefined;
  if (Array.isArray(dataFlow)) {
    return dataFlow.map((item, i) => {
      if (isPlainObject(item)) {
        return {
          step: item.step ?? i + 1,
          ...(item.location != null ? { location: String(item.location) } : {}),
          description: item.description != null ? String(item.description) : stringifyBlock(item),
        };
      }
      return { step: i + 1, description: String(item) };
    });
  }
  if (isPlainObject(dataFlow)) {
    return Object.entries(dataFlow).map(([key, value], i) => ({
      step: i + 1,
      location: key,
      description: stringifyBlock(value) ?? "",
    }));
  }
  return [{ step: 1, description: String(dataFlow) }];
}

/**
 * Convert one legacy YAML object to the new schema shape.
 * Idempotent: if metadata.anchors already exists, returns changed=false.
 */
export function migrateYamlDocument(input) {
  const doc = clone(input) ?? {};
  if (!isLegacyFindingYaml(doc)) return { changed: false, doc, reason: "already-new-or-unsupported" };

  const m = doc.metadata ?? (doc.metadata = {});
  const originalSeverity = m.severity;
  const line = asPositiveInt(m.line_number);
  const anchor = {};
  if (typeof m.file_path === "string" && m.file_path.trim()) anchor.file_path = m.file_path;
  if (line !== undefined) anchor.line = line;
  if (typeof m.function === "string" && m.function.trim()) anchor.function = m.function;
  if (Object.keys(anchor).length > 0) m.anchors = [anchor];

  // Current decision: keep the historical severity value in YAML, including
  // critical, so the original judgement is not lost. Platform DB/list still
  // normalizes unsupported critical to high through the indexer.
  if (originalSeverity != null) m.severity = originalSeverity;

  // New detail shape: description is an object. Preserve risk-specific extra
  // fields (entry_point / taint_source / trigger_condition) and any other
  // existing description keys verbatim.
  if (typeof doc.description === "string") {
    doc.description = { detailed_description: doc.description };
  } else if (!isPlainObject(doc.description)) {
    doc.description = {};
  }

  // Map old top-level attack into structured description without deleting
  // any existing description fields.
  if (doc.attack != null && doc.description.attack_description == null) {
    doc.description.attack_description = stringifyBlock(doc.attack);
  }

  // New code block. Preserve existing code fields, then add mapped legacy data.
  if (!isPlainObject(doc.code)) doc.code = {};
  if (doc.data_flow != null && doc.code.dataflow == null) {
    doc.code.dataflow = normalizeDataflow(doc.data_flow);
  }
  if (doc.remediation != null && doc.code.fix_code == null) {
    doc.code.fix_code = stringifyBlock(doc.remediation);
  }

  // Remove old top-level buckets that now have a new-schema home. Leave metadata
  // legacy fields in place for traceability/idempotent forensic review; anchors
  // is the canonical source for new parser/UI.
  delete doc.data_flow;
  delete doc.remediation;
  delete doc.attack;

  return { changed: true, doc };
}

export function findingKeyFromObjectKey(key) {
  const base = key.split("/").pop() ?? key;
  return base.replace(/\.ya?ml$/i, "");
}

export function classifyKey(key) {
  const parts = key.split("/");
  return {
    taskId: parts[1] ?? "unknown",
    itemType: key.includes("/risks/") ? "risk" : "finding",
    findingKey: findingKeyFromObjectKey(key),
  };
}

function emptyCounts() {
  return {
    total: 0,
    old: 0,
    new: 0,
    errors: 0,
    legacy_without_location: 0,
    byItemType: {
      finding: { total: 0, old: 0, new: 0, migrated: 0, errors: 0, legacy_without_location: 0 },
      risk: { total: 0, old: 0, new: 0, migrated: 0, errors: 0, legacy_without_location: 0 },
    },
    severity: {},
    tasks: {},
    oldSamples: [],
    errorsList: [],
  };
}

function bumpSeverity(report, sev) {
  const key = sev == null ? "<missing>" : String(sev).toLowerCase();
  report.severity[key] = (report.severity[key] ?? 0) + 1;
}

function addTask(report, taskId, itemType, field) {
  report.tasks[taskId] ??= { total: 0, old: 0, new: 0, migrated: 0, errors: 0, finding: 0, risk: 0 };
  report.tasks[taskId].total++;
  report.tasks[taskId][itemType]++;
  report.tasks[taskId][field]++;
}

async function readObjectText(minio, bucket, key) {
  const chunks = [];
  const stream = await minio.getObject(bucket, key);
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function putObjectText(minio, bucket, key, text) {
  const buf = Buffer.from(text, "utf8");
  await minio.putObject(bucket, key, buf, buf.length, { "Content-Type": "text/plain; charset=utf-8" });
}

async function listYamlKeys(minio, bucket, taskIds) {
  const keys = [];
  const stream = minio.listObjects(bucket, "scan-outputs/", true);
  await new Promise((resolve, reject) => {
    stream.on("data", (obj) => {
      const key = obj.name;
      if (!key || !/\/(findings|risks)\/.*\.ya?ml$/.test(key)) return;
      const { taskId } = classifyKey(key);
      if (taskIds.length && !taskIds.includes(taskId)) return;
      keys.push(key);
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return keys.sort();
}

function loadRuntimeDeps() {
  return {
    yaml: requireRuntimePackage("js-yaml"),
    Minio: requireRuntimePackage("minio"),
    postgres: requireRuntimePackage("postgres"),
  };
}

function loadConfigFromEnv() {
  return {
    dbUrl: process.env.DATABASE_URL ?? "postgresql://vulnhunter:vulnhunter@db:5432/vulnhunter",
    minio: {
      endPoint: process.env.MINIO_ENDPOINT ?? "minio",
      port: Number(process.env.MINIO_PORT ?? 9000),
      useSSL: process.env.MINIO_USE_SSL === "true",
      accessKey: process.env.MINIO_ACCESS_KEY ?? "minioadmin",
      secretKey: process.env.MINIO_SECRET_KEY ?? "minioadmin",
      bucket: process.env.MINIO_BUCKET ?? "artifact-store",
    },
  };
}

async function connect() {
  const { Minio, postgres } = loadRuntimeDeps();
  const config = loadConfigFromEnv();
  const minio = new Minio.Client(config.minio);
  const db = postgres(config.dbUrl, { max: 4, idle_timeout: 10, connect_timeout: 10 });
  return { config, minio, db };
}

async function backupRows(db, keys) {
  if (!keys.length) return [];
  return db`SELECT * FROM findings_meta WHERE yaml_minio_key = ANY(${keys}) ORDER BY task_id, finding_key`;
}

export function affectedRefsFromManifestItems(items) {
  return (items ?? []).map((item) => ({
    yamlMinioKey: item.originalKey,
    taskId: item.taskId,
    findingKey: item.findingKey ?? findingKeyFromObjectKey(item.originalKey),
    itemType: item.itemType,
  }));
}

async function restoreRows(db, rows, affectedRefs) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const affectedKeys = affectedRefs.map((ref) => ref.yamlMinioKey).filter(Boolean);
  let restored = 0;
  await db.begin(async (tx) => {
    // Restore scope is exact migrated YAML object keys, not whole tasks. This
    // removes rows created by apply/reindex for YAML objects that had no DB row
    // before apply, while preserving non-affected sibling rows in the same task.
    if (affectedKeys.length) {
      await tx`DELETE FROM findings_meta WHERE yaml_minio_key = ANY(${affectedKeys})`;
    }

    // Then insert only the rows that existed in the pre-apply backup.
    for (const row of rows) {
      await tx`INSERT INTO findings_meta ${tx(row, columns)}`;
      restored++;
    }
  });
  return { restored, deletedScope: affectedKeys.length };
}

async function reindexTasks(taskIds, bucket) {
  const distBase = process.env.SERVICE_DIST ?? "/app/packages/service/dist";
  try {
    const { initMinio } = await import(`${pathToFileURL(distBase)}/infra/minio/client.js`);
    const { initDb, closeDb } = await import(`${pathToFileURL(distBase)}/infra/db/client.js`);
    const { indexFindings } = await import(`${pathToFileURL(distBase)}/features/findings/indexer.js`);
    const config = loadConfigFromEnv();
    await initMinio({
      endpoint: config.minio.endPoint,
      port: config.minio.port,
      useSSL: config.minio.useSSL,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
      bucket: config.minio.bucket,
    });
    await initDb(config.dbUrl);
    const out = [];
    for (const taskId of taskIds) out.push({ taskId, indexed: await indexFindings(taskId, bucket) });
    await closeDb();
    return { ok: true, tasks: out };
  } catch (err) {
    return { ok: false, error: String(err), taskIds };
  }
}

export async function runMigration(args) {
  if (!["inventory", "dry-run", "apply", "restore"].includes(args.mode)) throw new Error(`Invalid --mode ${args.mode}`);
  const { yaml } = loadRuntimeDeps();
  const { config, minio, db } = await connect();
  const bucket = config.minio.bucket;
  try {
    if (args.mode === "restore") {
      if (!args.restorePrefix) throw new Error("--restore-prefix required for restore");
      const manifest = JSON.parse(await readObjectText(minio, bucket, `${args.restorePrefix.replace(/\/$/, "")}/manifest.json`));
      for (const item of manifest.items) {
        const raw = await readObjectText(minio, bucket, item.backupKey);
        await putObjectText(minio, bucket, item.originalKey, raw);
      }
      let restoredRows = 0;
      try {
        const rows = JSON.parse(await readObjectText(minio, bucket, manifest.findingsMetaBackupKey));
        const restored = await restoreRows(db, rows, affectedRefsFromManifestItems(manifest.items));
        restoredRows = restored.restored;
        manifest.restoreDeletedScope = restored.deletedScope;
      } catch (err) {
        manifest.restoreDbWarning = String(err);
      }
      return { mode: "restore", restoredObjects: manifest.items.length, restoredRows, manifest };
    }

    let keys = await listYamlKeys(minio, bucket, args.taskIds);
    if (args.limit > 0) keys = keys.slice(0, args.limit);
    const report = emptyCounts();
    const planned = [];

    for (const key of keys) {
      const { taskId, itemType } = classifyKey(key);
      report.total++;
      report.byItemType[itemType].total++;
      try {
        const raw = await readObjectText(minio, bucket, key);
        const doc = yaml.load(raw);
        const old = isLegacyFindingYaml(doc);
        const withoutLocation = isLegacyWithoutLocation(doc);
        if (withoutLocation) {
          report.legacy_without_location++;
          report.byItemType[itemType].legacy_without_location++;
        }
        if (old) {
          report.old++;
          report.byItemType[itemType].old++;
          addTask(report, taskId, itemType, "old");
          bumpSeverity(report, doc?.metadata?.severity);
          const migrated = migrateYamlDocument(doc);
          planned.push({ key, taskId, itemType, raw, migratedDoc: migrated.doc, severity: doc?.metadata?.severity, legacy_without_location: withoutLocation });
          if (report.oldSamples.length < 20) report.oldSamples.push({ key, itemType, title: doc?.metadata?.title, severity: doc?.metadata?.severity, file_path: doc?.metadata?.file_path, line_number: doc?.metadata?.line_number, cvss_score: doc?.metadata?.cvss_score, ev_score: doc?.metadata?.ev_score });
        } else {
          report.new++;
          report.byItemType[itemType].new++;
          addTask(report, taskId, itemType, "new");
        }
      } catch (err) {
        report.errors++;
        report.byItemType[itemType].errors++;
        addTask(report, taskId, itemType, "errors");
        report.errorsList.push({ key, error: String(err) });
      }
    }

    if (args.mode === "inventory" || args.mode === "dry-run") {
      return { mode: args.mode, report, plannedChanges: planned.length };
    }

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPrefix = (args.backupPrefix || `migration-backups/vulnforge-phase2/${runId}`).replace(/\/$/, "");
    const items = [];
    for (const p of planned) {
      const backupKey = `${backupPrefix}/objects/${p.key}`;
      await putObjectText(minio, bucket, backupKey, p.raw);
      items.push({ originalKey: p.key, backupKey: backupKey, taskId: p.taskId, findingKey: findingKeyFromObjectKey(p.key), itemType: p.itemType, severity: p.severity });
    }
    const rows = await backupRows(db, planned.map((p) => p.key));
    const findingsMetaBackupKey = `${backupPrefix}/findings_meta.json`;
    await putObjectText(minio, bucket, findingsMetaBackupKey, JSON.stringify(rows, null, 2));
    const manifest = {
      createdAt: new Date().toISOString(),
      mode: "apply",
      backupPrefix,
      reportBefore: report,
      items,
      findingsMetaBackupKey,
    };
    await putObjectText(minio, bucket, `${backupPrefix}/manifest.json`, JSON.stringify(manifest, null, 2));

    for (const p of planned) {
      await putObjectText(minio, bucket, p.key, yaml.dump(p.migratedDoc, { lineWidth: 120, noRefs: true, sortKeys: false }));
      report.byItemType[p.itemType].migrated++;
      report.tasks[p.taskId].migrated++;
      report.migrated = (report.migrated ?? 0) + 1;
    }

    const affectedTaskIds = [...new Set(planned.map((p) => p.taskId))];
    const reindex = args.reindex ? await reindexTasks(affectedTaskIds, bucket) : { ok: false, skipped: true, taskIds: affectedTaskIds };
    return { mode: "apply", backupPrefix, report, migrated: planned.length, affectedTaskIds, reindex };
  } finally {
    await db.end({ timeout: 5 }).catch(() => undefined);
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/vulnforge-schema-migration.mjs --mode inventory [--task-id ID]
  node scripts/ops/vulnforge-schema-migration.mjs --mode dry-run [--task-id ID]
  node scripts/ops/vulnforge-schema-migration.mjs --mode apply [--backup-prefix PREFIX] [--task-id ID] [--no-reindex]
  node scripts/ops/vulnforge-schema-migration.mjs --mode restore --restore-prefix PREFIX

Runtime:
  Preferred: run inside the vulnhunter-service container.
  Host execution is supported only when service workspace deps are available and
  DATABASE_URL / MINIO_* point at the target DB+MinIO.

Modes:
  inventory  Count old/new schema only.
  dry-run    Count and plan changes; no writes. Default.
  apply      Back up YAML + findings_meta, rewrite YAML, then reindex affected tasks.
  restore    Restore YAML + findings_meta from backup manifest.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  const result = await runMigration(args);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
