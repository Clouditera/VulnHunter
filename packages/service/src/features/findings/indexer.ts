/**
 * Findings Indexer: reads judged findings from MinIO YAML → upserts into findings_meta.
 * Called on: task completion, on stage_end events from deep-judge, or manually.
 */

import { load as yamlLoad } from "js-yaml";
import { getDb } from "../../infra/db/client.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import {
  isExpStatus,
  isFindingClass,
  isPocStatus,
  type ExpStatus,
  type FindingClass,
  type PocStatus,
  type Severity,
} from "@vulnagent/shared";

const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/** Normalize Chinese or English severity strings to our enum */
function normalizeSeverity(raw: string): Severity {
  const s = (raw ?? "").toLowerCase().trim();
  // Chinese: 高/中/低/信息
  if (s === "高" || s === "high" || s === "critical") return "high";
  if (s === "中" || s === "medium") return "medium";
  if (s === "低" || s === "low") return "low";
  return "info";
}

const SEVERITY_NUMERIC: Record<Severity, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export interface FindingYaml {
  // judged/tp/ schema (7-segment canonical)
  metadata?: {
    title?: string;
    vuln_type?: string;
    vuln_type_full_name?: string;
    severity?: string;
    file_path?: string;
    line_number?: number;
    function?: string;
    language?: string;
    group_id?: string;
    attack_surface?: string;
    route_path?: string;
    permission_requirement?: string;
    cwe?: string;
    // VulnForge CVSS / Exploit-Value scoring
    cvss_vector?: string;
    cvss_score?: number | string;
    ev_vector?: string;
    ev_score?: number | string;
    ev_priority?: string;
    ev_rationale?: string;
    // VulnForge audit schema anchors. Only anchors[0] is projected into
    // findings_meta for list/source-jump; full anchors remain in YAML detail.
    anchors?: Array<{
      file_path?: string;
      line?: number | string;
      function?: string;
    }>;
    // Engine review status is intentionally not mapped to platform
    // findings_meta.review_status (user review state).
    review_status?: string;
    finding_class?: unknown;
    poc_status?: unknown;
    exp_status?: unknown;
    affected_versions?: unknown;
  };
  // raw_findings/ schema (vulnerability + metadata split)
  vulnerability?: {
    vuln_type?: string;
    severity?: string;
    file_path?: string;
    line?: string | number;
    function?: string;
    language?: string;
    source?: string;
    sink?: string;
  };
  description?: unknown;
  code?: unknown;
  data_flow?: unknown;
  attack?: unknown;
  remediation?: unknown;
  references?: unknown;
  related?: unknown;
}

/** Coerce a CVSS/EV numeric field that may arrive as number or string. */
export function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a line number that may arrive as number/string; invalid values become undefined. */
function toLineNumber(value: number | string | null | undefined): number | undefined {
  const n = toNumberOrNull(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** VulnForge audit schema has no severity; derive platform severity from CVSS. */
export function severityFromCvss(score: number | null | undefined): Severity | undefined {
  if (score == null) return undefined;
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
}

interface ExtractedMeta {
  title?: string;
  vuln_type?: string;
  vuln_type_full_name?: string;
  severity?: string;
  file_path?: string;
  line_number?: number;
  function?: string;
  language?: string;
  group_id?: string;
  attack_surface?: string;
  route_path?: string;
  cwe?: string;
  cvss_vector: string | null;
  cvss_score: number | null;
  ev_vector: string | null;
  ev_score: number | null;
  ev_priority: string | null;
  ev_rationale: string | null;
  finding_class: FindingClass | null;
  poc_status: PocStatus | null;
  exp_status: ExpStatus | null;
  affected_versions: string | null;
}

export interface DynamicProjection {
  finding_class: FindingClass | null;
  poc_status: PocStatus | null;
  exp_status: ExpStatus | null;
  affected_versions: string | null;
  warnings: Array<{
    code: "WARN_FINDING_ENUM_UNKNOWN" | "WARN_FINDING_ENUM_INVALID_TYPE" | "WARN_FINDING_REQUIRED_FIELD_MISSING" | "WARN_FINDING_AFFECTED_VERSIONS_INVALID_TYPE";
    field: "finding_class" | "poc_status" | "exp_status" | "affected_versions";
    raw_type: string;
  }>;
}

function rawType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function normalizeFindingDynamicMeta(metadata: FindingYaml["metadata"], canonical: boolean): DynamicProjection {
  const warnings: DynamicProjection["warnings"] = [];
  const normalizeEnum = <T extends FindingClass | PocStatus | ExpStatus>(
    field: "finding_class" | "poc_status" | "exp_status",
    value: unknown,
    guard: (candidate: unknown) => candidate is T,
    required: boolean,
  ): T | null => {
    if (value == null || (typeof value === "string" && value.trim() === "")) {
      if (canonical && required) warnings.push({ code: "WARN_FINDING_REQUIRED_FIELD_MISSING", field, raw_type: rawType(value) });
      return null;
    }
    if (typeof value !== "string") {
      warnings.push({ code: "WARN_FINDING_ENUM_INVALID_TYPE", field, raw_type: rawType(value) });
      return "unknown" as T;
    }
    const trimmed = value.trim();
    if (guard(trimmed)) return trimmed;
    warnings.push({ code: "WARN_FINDING_ENUM_UNKNOWN", field, raw_type: "string" });
    return "unknown" as T;
  };

  const affectedRaw = metadata?.affected_versions;
  let affectedVersions: string | null = null;
  if (affectedRaw != null) {
    if (typeof affectedRaw === "string") affectedVersions = affectedRaw.trim() || null;
    else warnings.push({ code: "WARN_FINDING_AFFECTED_VERSIONS_INVALID_TYPE", field: "affected_versions", raw_type: rawType(affectedRaw) });
  }

  return {
    finding_class: normalizeEnum("finding_class", metadata?.finding_class, isFindingClass, true),
    poc_status: normalizeEnum("poc_status", metadata?.poc_status, isPocStatus, true),
    exp_status: normalizeEnum("exp_status", metadata?.exp_status, isExpStatus, false),
    affected_versions: affectedVersions,
    warnings,
  };
}

/** Normalize finding YAML into a flat metadata object regardless of schema version */
export function extractMeta(finding: FindingYaml): ExtractedMeta {
  const v = finding.vulnerability;
  const m = finding.metadata;
  const dynamic = normalizeFindingDynamicMeta(m, false);

  // CVSS/EV only exist on the canonical metadata block (VulnForge schema).
  const scoring = {
    cvss_vector: m?.cvss_vector ?? null,
    cvss_score: toNumberOrNull(m?.cvss_score),
    ev_vector: m?.ev_vector ?? null,
    ev_score: toNumberOrNull(m?.ev_score),
    ev_priority: m?.ev_priority ?? null,
    ev_rationale: m?.ev_rationale ?? null,
  };
  const firstAnchor = Array.isArray(m?.anchors) ? m.anchors[0] : undefined;
  const anchorFile = typeof firstAnchor?.file_path === "string" && firstAnchor.file_path.trim()
    ? firstAnchor.file_path
    : undefined;
  const anchorFunction = typeof firstAnchor?.function === "string" && firstAnchor.function.trim()
    ? firstAnchor.function
    : undefined;
  const anchorLine = toLineNumber(firstAnchor?.line);
  const derivedSeverity = severityFromCvss(scoring.cvss_score);

  // If has vulnerability block (raw_findings schema), merge it with metadata
  if (v) {
    return {
      title: m?.title,
      vuln_type: v.vuln_type ?? m?.vuln_type,
      vuln_type_full_name: m?.vuln_type_full_name,
      severity: derivedSeverity ?? v.severity ?? m?.severity,
      file_path: (anchorFile ?? v.file_path ?? m?.file_path ?? "").replace(/^\/workspace\/src\//, ""),
      line_number: anchorLine ?? toLineNumber(v.line) ?? toLineNumber(m?.line_number),
      function: anchorFunction ?? v.function ?? m?.function,
      language: v.language ?? m?.language,
      group_id: m?.group_id,
      attack_surface: m?.attack_surface ?? v.source,
      cwe: m?.cwe,
      ...scoring,
      finding_class: dynamic.finding_class,
      poc_status: dynamic.poc_status,
      exp_status: dynamic.exp_status,
      affected_versions: dynamic.affected_versions,
    };
  }

  // New VulnForge audit / judged canonical schema — metadata block has everything.
  // Prefer anchors[0] for the platform's primary source jump. Full anchors stay
  // in the YAML served by the detail endpoint.
  if (m) {
    return {
      ...m,
      severity: derivedSeverity ?? m.severity,
      file_path: anchorFile ?? m.file_path,
      line_number: anchorLine ?? toLineNumber(m.line_number),
      function: anchorFunction ?? m.function,
      ...scoring,
      finding_class: dynamic.finding_class,
      poc_status: dynamic.poc_status,
      exp_status: dynamic.exp_status,
      affected_versions: dynamic.affected_versions,
    };
  }

  return {
    ...scoring,
    finding_class: dynamic.finding_class,
    poc_status: dynamic.poc_status,
    exp_status: dynamic.exp_status,
    affected_versions: dynamic.affected_versions,
  };
}

async function readYamlFromMinio(bucket: string, key: string): Promise<string> {
  const minio = getMinio();
  const stream = await minio.getObject(bucket, key);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", reject);
  });
}

/** List all YAML files under a prefix in MinIO */
async function listMinioObjects(bucket: string, prefix: string): Promise<string[]> {
  const minio = getMinio();
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) keys.push(obj.name); });
    stream.on("end", () => resolve(keys));
    stream.on("error", reject);
  });
}

export type FindingSourceKind = "canonical_v2" | "legacy_finding" | "legacy_raw" | "legacy_risk";

export interface FindingCandidate {
  objectKey: string;
  findingKey: string;
  itemType: "finding" | "risk";
  sourceKind: FindingSourceKind;
  priority: 400 | 300 | 200 | 100;
  canonical: boolean;
}

const LEGACY_FILE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,199})\.(yaml|yml)$/;
const CANONICAL_ID_RE = /^BUG-[A-Za-z0-9._-]+$/;

/** Exact, task-scoped object-key matcher. Nested YAML is deliberately ignored. */
export function matchFindingObjectKey(taskId: string, objectKey: string): FindingCandidate | null {
  const taskPrefix = `scan-outputs/${taskId}/`;
  if (!objectKey.startsWith(taskPrefix)) return null;
  const relative = objectKey.slice(taskPrefix.length);

  const canonical = /^findings\/([^/]+)\/report\.yaml$/.exec(relative);
  if (canonical) {
    const findingKey = canonical[1]!;
    if (findingKey.length <= 200 && CANONICAL_ID_RE.test(findingKey) && findingKey !== "BUG-") {
      return { objectKey, findingKey, itemType: "finding", sourceKind: "canonical_v2", priority: 400, canonical: true };
    }
    return null;
  }

  const specs: Array<{ prefix: string; itemType: "finding" | "risk"; sourceKind: FindingSourceKind; priority: 300 | 200 | 100 }> = [
    { prefix: "findings/", itemType: "finding", sourceKind: "legacy_finding", priority: 300 },
    { prefix: "raw_findings/", itemType: "finding", sourceKind: "legacy_raw", priority: 200 },
    { prefix: "risks/", itemType: "risk", sourceKind: "legacy_risk", priority: 100 },
  ];
  for (const spec of specs) {
    if (!relative.startsWith(spec.prefix)) continue;
    const rest = relative.slice(spec.prefix.length);
    if (rest.includes("/")) return null;
    const match = LEGACY_FILE_RE.exec(rest);
    if (!match || match[1] === "report") return null;
    return {
      objectKey,
      findingKey: match[1]!,
      itemType: spec.itemType,
      sourceKind: spec.sourceKind,
      priority: spec.priority,
      canonical: false,
    };
  }
  return null;
}

export function selectFindingCandidates(candidates: FindingCandidate[]): {
  winners: FindingCandidate[];
  collisions: Array<{ winner: FindingCandidate; loser: FindingCandidate }>;
} {
  const groups = new Map<string, FindingCandidate[]>();
  for (const candidate of candidates) {
    const values = groups.get(candidate.findingKey) ?? [];
    values.push(candidate);
    groups.set(candidate.findingKey, values);
  }
  const winners: FindingCandidate[] = [];
  const collisions: Array<{ winner: FindingCandidate; loser: FindingCandidate }> = [];
  for (const findingKey of [...groups.keys()].sort()) {
    const values = groups.get(findingKey)!.sort((a, b) => b.priority - a.priority || (a.objectKey < b.objectKey ? -1 : a.objectKey > b.objectKey ? 1 : 0));
    const winner = values[0]!;
    winners.push(winner);
    for (const loser of values.slice(1)) collisions.push({ winner, loser });
  }
  return { winners, collisions };
}

function safeErrorClass(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownError";
}

export async function indexFindings(taskId: string, bucket: string): Promise<number> {
  const db = getDb();
  const taskRows = await db<{ tenant_id: string }[]>`
    SELECT tenant_id FROM tasks WHERE id = ${taskId} LIMIT 1
  `;
  const tenantId = taskRows[0]?.tenant_id ?? DEFAULT_TENANT_ID;

  let findingsCandidates: FindingCandidate[] = [];
  try {
    const keys = await listMinioObjects(bucket, `scan-outputs/${taskId}/findings/`);
    findingsCandidates = keys
      .map((key) => matchFindingObjectKey(taskId, key))
      .filter((candidate): candidate is FindingCandidate => candidate?.sourceKind === "canonical_v2" || candidate?.sourceKind === "legacy_finding");
  } catch (error) {
    logger.warn({ code: "WARN_FINDING_DISCOVERY_FAILED", taskId, prefix: "findings", error_class: safeErrorClass(error) }, "Finding discovery failed closed");
    return 0;
  }

  const candidates = [...findingsCandidates];
  if (findingsCandidates.length === 0) {
    try {
      const keys = await listMinioObjects(bucket, `scan-outputs/${taskId}/raw_findings/`);
      candidates.push(...keys
        .map((key) => matchFindingObjectKey(taskId, key))
        .filter((candidate): candidate is FindingCandidate => candidate?.sourceKind === "legacy_raw"));
    } catch (error) {
      logger.warn({ code: "WARN_FINDING_DISCOVERY_FAILED", taskId, prefix: "raw_findings", error_class: safeErrorClass(error) }, "Finding discovery failed closed");
      return 0;
    }
  }

  try {
    const keys = await listMinioObjects(bucket, `scan-outputs/${taskId}/risks/`);
    candidates.push(...keys
      .map((key) => matchFindingObjectKey(taskId, key))
      .filter((candidate): candidate is FindingCandidate => candidate?.sourceKind === "legacy_risk"));
  } catch (error) {
    logger.warn({ code: "WARN_FINDING_DISCOVERY_FAILED", taskId, prefix: "risks", error_class: safeErrorClass(error) }, "Finding discovery failed closed");
    return 0;
  }

  const { winners, collisions } = selectFindingCandidates(candidates);
  for (const { winner, loser } of collisions) {
    logger.warn({
      code: "WARN_FINDING_SOURCE_COLLISION",
      taskId,
      findingKey: winner.findingKey,
      winner_key: winner.objectKey,
      winner_source: winner.sourceKind,
      loser_key: loser.objectKey,
      loser_source: loser.sourceKind,
    }, "Finding source collision; deterministic winner selected");
  }

  if (winners.length === 0) {
    logger.info({ taskId }, "No accepted findings/risks candidates found");
    return 0;
  }

  let indexed = 0;
  let failed = 0;
  for (const candidate of winners) {
    const success = await indexOneCandidate(db, taskId, tenantId, bucket, candidate);
    if (success) indexed++;
    else failed++;
  }

  if (failed === 0) {
    await db`UPDATE tasks SET findings_indexed_at = now() WHERE id = ${taskId}`;
  } else {
    logger.warn({ code: "WARN_FINDING_INDEX_PARTIAL", taskId, indexed, failed }, "Finding indexing completed partially; timestamp not advanced");
  }

  logger.info({ taskId, indexed, failed, selected: winners.length }, "Findings indexed");
  return indexed;
}

/** Index one selected winner. A failure never falls back to collision losers. */
async function indexOneCandidate(
  db: ReturnType<typeof getDb>,
  taskId: string,
  tenantId: string,
  bucket: string,
  candidate: FindingCandidate,
): Promise<boolean> {
  try {
    const raw = await readYamlFromMinio(bucket, candidate.objectKey);
    const parsed = yamlLoad(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Invalid finding YAML root");
    const finding = parsed as FindingYaml;
    if ((!finding.metadata || typeof finding.metadata !== "object" || Array.isArray(finding.metadata))
      && (!finding.vulnerability || typeof finding.vulnerability !== "object" || Array.isArray(finding.vulnerability))) {
      throw new TypeError("Finding YAML lacks metadata/vulnerability object");
    }

    const meta = extractMeta(finding);
    const dynamic = normalizeFindingDynamicMeta(finding.metadata, candidate.canonical);
    for (const warning of dynamic.warnings) {
      logger.warn({
        code: warning.code,
        taskId,
        findingKey: candidate.findingKey,
        object_key: candidate.objectKey,
        field: warning.field,
        raw_type: warning.raw_type,
      }, "Finding dynamic metadata normalized with warning");
    }
    const severity = normalizeSeverity(meta.severity ?? "");
    const severityNumeric = SEVERITY_NUMERIC[severity];

    await db`
      INSERT INTO findings_meta (
        task_id, tenant_id, finding_key, yaml_minio_key,
        severity, severity_numeric, vuln_type, vuln_type_full,
        cwe, primary_file, primary_line, function_name, language,
        group_id, attack_surface, route_path, schema_version,
        cvss_vector, cvss_score, ev_vector, ev_score, ev_priority, ev_rationale,
        finding_class, poc_status, exp_status, affected_versions,
        item_type, title
      ) VALUES (
        ${taskId}, ${tenantId}, ${candidate.findingKey}, ${candidate.objectKey},
        ${severity}, ${severityNumeric}, ${meta.vuln_type ?? null},
        ${meta.vuln_type_full_name ?? null},
        ${meta.cwe ?? null}, ${meta.file_path ?? null},
        ${meta.line_number ?? null}, ${meta.function ?? null},
        ${meta.language ?? null}, ${meta.group_id ?? null},
        ${meta.attack_surface ?? null}, ${meta.route_path ?? null},
        1,
        ${meta.cvss_vector}, ${meta.cvss_score},
        ${meta.ev_vector}, ${meta.ev_score},
        ${meta.ev_priority}, ${meta.ev_rationale},
        ${dynamic.finding_class}, ${dynamic.poc_status},
        ${dynamic.exp_status}, ${dynamic.affected_versions},
        ${candidate.itemType}, ${meta.title ?? null}
      )
      ON CONFLICT (task_id, finding_key) DO UPDATE SET
        yaml_minio_key = EXCLUDED.yaml_minio_key,
        severity = EXCLUDED.severity,
        severity_numeric = EXCLUDED.severity_numeric,
        vuln_type = EXCLUDED.vuln_type,
        vuln_type_full = EXCLUDED.vuln_type_full,
        title = EXCLUDED.title,
        cwe = EXCLUDED.cwe,
        primary_file = EXCLUDED.primary_file,
        primary_line = EXCLUDED.primary_line,
        function_name = EXCLUDED.function_name,
        language = EXCLUDED.language,
        group_id = EXCLUDED.group_id,
        attack_surface = EXCLUDED.attack_surface,
        route_path = EXCLUDED.route_path,
        cvss_vector = EXCLUDED.cvss_vector,
        cvss_score = EXCLUDED.cvss_score,
        ev_vector = EXCLUDED.ev_vector,
        ev_score = EXCLUDED.ev_score,
        ev_priority = EXCLUDED.ev_priority,
        ev_rationale = EXCLUDED.ev_rationale,
        finding_class = EXCLUDED.finding_class,
        poc_status = EXCLUDED.poc_status,
        exp_status = EXCLUDED.exp_status,
        affected_versions = EXCLUDED.affected_versions,
        item_type = EXCLUDED.item_type,
        indexed_at = now()
    `;
    return true;
  } catch (error) {
    logger.warn({
      code: "WARN_FINDING_INDEX_FAILED",
      taskId,
      findingKey: candidate.findingKey,
      object_key: candidate.objectKey,
      source_kind: candidate.sourceKind,
      error_class: safeErrorClass(error),
    }, "Failed to index selected finding candidate");
    return false;
  }
}
