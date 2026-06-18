/**
 * Findings Indexer: reads judged findings from MinIO YAML → upserts into findings_meta.
 * Called on: task completion, on stage_end events from deep-judge, or manually.
 */

import { load as yamlLoad } from "js-yaml";
import { getDb } from "../../infra/db/client.js";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import type { Severity } from "@vulnagent/shared";

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
}

/** Normalize finding YAML into a flat metadata object regardless of schema version */
export function extractMeta(finding: FindingYaml): ExtractedMeta {
  const v = finding.vulnerability;
  const m = finding.metadata;

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
    };
  }

  return { ...scoring };
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

export async function indexFindings(taskId: string, bucket: string): Promise<number> {
  const db = getDb();

  // Resolve tenant from the task record (indexer runs as a system action from
  // the scheduler, but findings_meta is tenant-scoped). Fall back to default.
  const taskRows = await db<{ tenant_id: string }[]>`
    SELECT tenant_id FROM tasks WHERE id = ${taskId} LIMIT 1
  `;
  const tenantId = taskRows[0]?.tenant_id ?? DEFAULT_TENANT_ID;

  // findings/ is the canonical source of truth for confirmed vulnerabilities.
  // It contains the final, deduplicated, judged results from YoungFlow.
  // Fallback to raw_findings/ for older scans that predate the findings/ convention.
  const findingPrefixes = [
    `scan-outputs/${taskId}/findings/`,
    `scan-outputs/${taskId}/raw_findings/`,
  ];

  let findingKeys: string[] = [];
  for (const prefix of findingPrefixes) {
    try {
      const keys = await listMinioObjects(bucket, prefix);
      const filtered = keys.filter((k) => k.endsWith(".yaml") || k.endsWith(".yml"));
      if (filtered.length > 0) {
        findingKeys = filtered;
        logger.info({ taskId, prefix, count: filtered.length }, "Found findings at prefix");
        break;
      }
    } catch (err) {
      logger.debug({ err, taskId, prefix }, "Failed to list findings at prefix");
    }
  }

  // risks/ holds VulnForge RISK-*.yaml items (same schema, item_type='risk').
  let riskKeys: string[] = [];
  try {
    const keys = await listMinioObjects(bucket, `scan-outputs/${taskId}/risks/`);
    riskKeys = keys.filter((k) => k.endsWith(".yaml") || k.endsWith(".yml"));
    if (riskKeys.length > 0) {
      logger.info({ taskId, count: riskKeys.length }, "Found risks at prefix");
    }
  } catch (err) {
    logger.debug({ err, taskId }, "Failed to list risks prefix");
  }

  if (findingKeys.length === 0 && riskKeys.length === 0) {
    logger.info({ taskId }, "No findings/risks YAML files found in any prefix");
    return 0;
  }

  let indexed = 0;
  for (const key of findingKeys) {
    indexed += await indexOneYaml(db, taskId, tenantId, bucket, key, "finding");
  }
  for (const key of riskKeys) {
    indexed += await indexOneYaml(db, taskId, tenantId, bucket, key, "risk");
  }

  // Mark as indexed
  await db`
    UPDATE tasks SET findings_indexed_at = now() WHERE id = ${taskId}
  `;

  logger.info({ taskId, indexed, findings: findingKeys.length, risks: riskKeys.length }, "Findings indexed");
  return indexed;
}

/** Index a single finding/risk YAML into findings_meta. Returns 1 on success, 0 on skip/error. */
async function indexOneYaml(
  db: ReturnType<typeof getDb>,
  taskId: string,
  tenantId: string,
  bucket: string,
  key: string,
  itemType: "finding" | "risk",
): Promise<number> {
  const findingKey = key.split("/").pop()?.replace(/\.ya?ml$/, "") ?? key;
  try {
    const raw = await readYamlFromMinio(bucket, key);
    const finding = yamlLoad(raw) as FindingYaml;
    if (!finding?.metadata && !finding?.vulnerability) return 0;

    const meta = extractMeta(finding);
    const severity = normalizeSeverity(meta.severity ?? "");
    const severityNumeric = SEVERITY_NUMERIC[severity];

    await db`
      INSERT INTO findings_meta (
        task_id, tenant_id, finding_key, yaml_minio_key,
        severity, severity_numeric, vuln_type, vuln_type_full,
        cwe, primary_file, primary_line, function_name, language,
        group_id, attack_surface, route_path, schema_version,
        cvss_vector, cvss_score, ev_vector, ev_score, ev_priority, ev_rationale,
        item_type, title
      ) VALUES (
        ${taskId}, ${tenantId}, ${findingKey}, ${key},
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
        ${itemType}, ${meta.title ?? null}
      )
      ON CONFLICT (task_id, finding_key) DO UPDATE SET
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
        item_type = EXCLUDED.item_type,
        indexed_at = now()
    `;
    return 1;
  } catch (err) {
    logger.warn({ err, key }, "Failed to index finding");
    return 0;
  }
}
