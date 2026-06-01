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

/** Normalize finding YAML into a flat metadata object regardless of schema version */
function extractMeta(finding: FindingYaml): FindingYaml["metadata"] & Record<string, unknown> {
  const v = finding.vulnerability;
  const m = finding.metadata;

  // If has vulnerability block (raw_findings schema), merge it with metadata
  if (v) {
    return {
      vuln_type: v.vuln_type ?? m?.vuln_type,
      vuln_type_full_name: m?.vuln_type_full_name,
      severity: v.severity ?? m?.severity,
      file_path: (v.file_path ?? m?.file_path ?? "").replace(/^\/workspace\/src\//, ""),
      line_number: v.line != null ? Number(v.line) : m?.line_number,
      function: v.function ?? m?.function,
      language: v.language ?? m?.language,
      group_id: m?.group_id,
      attack_surface: m?.attack_surface ?? v.source,
      cwe: m?.cwe,
    };
  }

  // judged/tp/ canonical schema — metadata block has everything
  if (m) return m;

  return {};
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

  // findings/ is the canonical source of truth for vulnerabilities.
  // It contains the final, deduplicated, judged results from YoungFlow.
  // Fallback to raw_findings/ for older scans that predate the findings/ convention.
  const prefixes = [
    `scan-outputs/${taskId}/findings/`,
    `scan-outputs/${taskId}/raw_findings/`,
  ];

  let yamlKeys: string[] = [];
  for (const prefix of prefixes) {
    try {
      const keys = await listMinioObjects(bucket, prefix);
      const filtered = keys.filter((k) => k.endsWith(".yaml") || k.endsWith(".yml"));
      if (filtered.length > 0) {
        yamlKeys = filtered;
        logger.info({ taskId, prefix, count: filtered.length }, "Found findings at prefix");
        break;
      }
    } catch (err) {
      logger.debug({ err, taskId, prefix }, "Failed to list findings at prefix");
    }
  }

  if (yamlKeys.length === 0) {
    logger.info({ taskId }, "No findings YAML files found in any prefix");
    return 0;
  }

  let indexed = 0;

  for (const key of yamlKeys) {
    const findingKey = key.split("/").pop()?.replace(/\.ya?ml$/, "") ?? key;

    try {
      const raw = await readYamlFromMinio(bucket, key);
      const finding = yamlLoad(raw) as FindingYaml;
      if (!finding?.metadata && !finding?.vulnerability) continue;

      const meta = extractMeta(finding);
      const severity = normalizeSeverity(meta.severity ?? "");
      const severityNumeric = SEVERITY_NUMERIC[severity];

      await db`
        INSERT INTO findings_meta (
          task_id, tenant_id, finding_key, yaml_minio_key,
          severity, severity_numeric, vuln_type, vuln_type_full,
          cwe, primary_file, primary_line, function_name, language,
          group_id, attack_surface, route_path, schema_version
        ) VALUES (
          ${taskId}, ${DEFAULT_TENANT_ID}, ${findingKey}, ${key},
          ${severity}, ${severityNumeric}, ${meta.vuln_type ?? null},
          ${meta.vuln_type_full_name ?? null},
          ${meta.cwe ?? null}, ${meta.file_path ?? null},
          ${meta.line_number ?? null}, ${meta.function ?? null},
          ${meta.language ?? null}, ${meta.group_id ?? null},
          ${meta.attack_surface ?? null}, ${meta.route_path ?? null},
          1
        )
        ON CONFLICT (task_id, finding_key) DO UPDATE SET
          severity = EXCLUDED.severity,
          severity_numeric = EXCLUDED.severity_numeric,
          vuln_type = EXCLUDED.vuln_type,
          primary_file = EXCLUDED.primary_file,
          primary_line = EXCLUDED.primary_line,
          indexed_at = now()
      `;
      indexed++;
    } catch (err) {
      logger.warn({ err, key }, "Failed to index finding");
    }
  }

  // Mark as indexed
  await db`
    UPDATE tasks SET findings_indexed_at = now() WHERE id = ${taskId}
  `;

  logger.info({ taskId, indexed }, "Findings indexed");
  return indexed;
}
