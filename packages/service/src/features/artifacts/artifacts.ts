/**
 * H4 dynamic artifact read model: file listing + read-only preview for the
 * Finding three-card UI and the EXP page.
 *
 * Exposure is deliberately narrow (H4 §1): only the `findings/` and
 * `exploits/` output roots are reachable. knowledge/, leads/, todo/, done/,
 * .youngflow/ are internal progress/experience signals and are never exposed;
 * the chain four-state is derived server-side and returned as a state field.
 */

import { load as yamlLoad } from "js-yaml";
import { getMinio } from "../../infra/minio/client.js";
import { logger } from "../../infra/logger.js";
import { CANONICAL_ID_RE } from "../findings/indexer.js";
import {
  classifyCodeFileBuffer,
  MAX_IMAGE_PREVIEW_BYTES,
  type CodeFileResult,
} from "../workspace/code-viewer.js";
import type { DbTask } from "../tasks/storage.js";

export const ARTIFACT_ROOTS = ["findings", "exploits"] as const;
/** v1 is preview-only (fish: no execution, no download) — neutral marker. */
export const ARTIFACT_TRUNCATED_MARKER = "\n\n[File truncated]";

const EXPLOIT_ID_RE = /^EXP-[A-Za-z0-9._-]+$/;
const CHAIN_TODO_RE = /^CHAIN-[A-Za-z0-9._-]+\.md$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f]/;

export type ArtifactKind = "text" | "image" | "binary";

export interface ArtifactFileEntry {
  path: string;
  size: number;
  kind: ArtifactKind;
  previewable: boolean;
}

export interface FindingArtifactGroups {
  poc: { files: ArtifactFileEntry[] };
  exp: { files: ArtifactFileEntry[] };
}

export type ExploitPageState = "not_enabled" | "pending" | "running" | "done";

export interface ChainReportProjection {
  title: string | null;
  members: string[];
  cwe: string | null;
  cvss_vector: string | null;
  cvss_score: number | null;
  ev_vector: string | null;
  ev_score: number | null;
  ev_priority: string | null;
  background: string | null;
  combined_impact: string | null;
  chain: Array<{
    step: number | string | null;
    finding: string | null;
    role: string | null;
    evidence: string | null;
  }>;
}

export interface ExploitChainEntry {
  id: string;
  report?: ChainReportProjection;
  parse_error?: boolean;
}

/**
 * Validate + normalize a caller-supplied artifact path (H4 §2.③ checks 1-2):
 * must stay under a whitelisted root, no traversal, no leading slash, no
 * duplicate separators, no backslashes/control chars. Returns null when
 * invalid. Membership in the task tree is checked separately (no existence
 * leakage for paths failing any check).
 */
export function normalizeArtifactPath(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  if (raw.length > 512 || CONTROL_CHAR_RE.test(raw) || raw.includes("\\")) return null;
  if (raw.startsWith("/") || raw.endsWith("/") || raw.includes("//")) return null;
  const segments = raw.split("/");
  if (segments.length < 2) return null;
  if (!ARTIFACT_ROOTS.includes(segments[0]! as (typeof ARTIFACT_ROOTS)[number])) return null;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return null;
  }
  return segments.join("/");
}

export function isValidFindingId(findingId: string): boolean {
  return findingId.length <= 200 && CANONICAL_ID_RE.test(findingId) && findingId !== "BUG-";
}

export function isValidExploitId(exploitId: string): boolean {
  return exploitId.length <= 200 && EXPLOIT_ID_RE.test(exploitId) && exploitId !== "EXP-";
}

/** task.source_meta carries enable_chain once task creation exposes it (H6); absent => off. */
export function isChainEnabled(task: Pick<DbTask, "source_meta">): boolean {
  const raw = task.source_meta?.["enable_chain"];
  return raw === true || (typeof raw === "string" && raw.trim().toLowerCase() === "true");
}

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

/**
 * EXP page four-state derivation (H4 §2.②). Ingredients: task enable_chain
 * config, todo/CHAIN-* existence, task terminal state, exploits/EXP-*\/report.yaml
 * existence. Frontend never judges paths itself.
 */
export function deriveExploitPageState(input: {
  chainEnabled: boolean;
  taskState: string;
  chainTodoCount: number;
  chainReportCount: number;
}): ExploitPageState {
  if (!input.chainEnabled) return "not_enabled";
  if (input.chainReportCount > 0) return "done";
  if (TERMINAL_STATES.has(input.taskState)) return "done";
  if (input.chainTodoCount > 0) return "running";
  return "pending";
}

/** Ordering convention (H4 §3.4): primary doc first, then by filename. */
export function sortArtifactFiles(files: ArtifactFileEntry[], primaryBasename: string): ArtifactFileEntry[] {
  return [...files].sort((a, b) => {
    const aPrimary = a.path.endsWith(`/${primaryBasename}`) || a.path === primaryBasename;
    const bPrimary = b.path.endsWith(`/${primaryBasename}`) || b.path === primaryBasename;
    if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

async function listObjectKeys(bucket: string, prefix: string): Promise<Array<{ name: string; size: number }>> {
  const minio = getMinio();
  return new Promise((resolve, reject) => {
    const out: Array<{ name: string; size: number }> = [];
    const stream = minio.listObjects(bucket, prefix, true);
    stream.on("data", (obj) => { if (obj.name) out.push({ name: obj.name, size: obj.size ?? 0 }); });
    stream.on("end", () => resolve(out));
    stream.on("error", reject);
  });
}

async function readObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  const minio = getMinio();
  const stream = await minio.getObject(bucket, key);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** All artifact-relative paths present under the two whitelisted roots. */
export async function listArtifactTree(taskId: string, bucket: string): Promise<Set<string>> {
  const prefix = `scan-outputs/${taskId}/`;
  const tree = new Set<string>();
  for (const root of ARTIFACT_ROOTS) {
    const objects = await listObjectKeys(bucket, `${prefix}${root}/`);
    for (const obj of objects) tree.add(obj.name.slice(prefix.length));
  }
  return tree;
}

/**
 * Classify a listing entry. Sniffing reuses the shipped code-viewer machine
 * (buffer based); objects beyond the image-preview cap are never previewable
 * anyway, so they are labelled binary without a download.
 */
async function classifyListingEntry(bucket: string, key: string, size: number): Promise<ArtifactKind> {
  if (size > MAX_IMAGE_PREVIEW_BYTES) return "binary";
  try {
    const buf = await readObjectBuffer(bucket, key);
    const result = await classifyCodeFileBuffer(buf, key);
    return result.type;
  } catch (error) {
    logger.warn({ code: "WARN_ARTIFACT_CLASSIFY_FAILED", key, error_class: error instanceof Error ? error.name : "UnknownError" }, "Artifact classification failed closed");
    return "binary";
  }
}

export async function listFindingArtifacts(taskId: string, findingId: string, bucket: string): Promise<FindingArtifactGroups> {
  const prefix = `scan-outputs/${taskId}/findings/${findingId}/`;
  const groups: FindingArtifactGroups = { poc: { files: [] }, exp: { files: [] } };
  for (const dir of ["poc", "exp"] as const) {
    const objects = await listObjectKeys(bucket, `${prefix}${dir}/`);
    const files: ArtifactFileEntry[] = [];
    for (const obj of objects) {
      const rel = obj.name.slice(prefix.length); // e.g. poc/poc.md
      const kind = await classifyListingEntry(bucket, obj.name, obj.size);
      files.push({ path: rel, size: obj.size, kind, previewable: kind === "text" || kind === "image" });
    }
    groups[dir].files = sortArtifactFiles(files, `${dir}.md`);
  }
  return groups;
}

/**
 * List a single exploit chain's artifacts (`exploits/<exploitId>/`) for the EXP
 * page's companion file list (contract gap: H4 listed findings but not
 * exploits). Returns exploit-relative paths (e.g. exp.md, harness.c) with
 * exp.md prioritized. Whitelisted to the exploits/ root only — no traversal.
 */
export async function listExploitArtifacts(taskId: string, exploitId: string, bucket: string): Promise<{ files: ArtifactFileEntry[] }> {
  const prefix = `scan-outputs/${taskId}/exploits/${exploitId}/`;
  const objects = await listObjectKeys(bucket, prefix);
  const files: ArtifactFileEntry[] = [];
  for (const obj of objects) {
    const rel = obj.name.slice(prefix.length); // e.g. exp.md, sub/harness.c
    if (!rel || rel.endsWith("/")) continue;
    const kind = await classifyListingEntry(bucket, obj.name, obj.size);
    files.push({ path: rel, size: obj.size, kind, previewable: kind === "text" || kind === "image" });
  }
  return { files: sortArtifactFiles(files, "exp.md") };
}

/** Parse + project a chain-report.yaml (chain-report schema, no chain_status). */
export function parseChainReport(raw: string): ChainReportProjection {
  const doc = yamlLoad(raw) as any;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new TypeError("chain report root must be a mapping");
  const metadata = doc.metadata;
  const description = doc.description;
  const chain = doc.chain;
  if (!metadata || typeof metadata !== "object") throw new TypeError("chain report lacks metadata");
  if (!Array.isArray(metadata.members) || metadata.members.length < 2) throw new TypeError("chain report members must list >=2 finding ids");
  if (!description || typeof description !== "object") throw new TypeError("chain report lacks description");
  if (typeof description.combined_impact !== "string" || !description.combined_impact) throw new TypeError("chain report lacks combined_impact");
  if (!Array.isArray(chain) || chain.length < 2) throw new TypeError("chain report chain must have >=2 steps");
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    title: text(metadata.title),
    members: metadata.members.map((m: unknown) => String(m)),
    cwe: text(metadata.cwe),
    cvss_vector: text(metadata.cvss_vector),
    cvss_score: num(metadata.cvss_score),
    ev_vector: text(metadata.ev_vector),
    ev_score: num(metadata.ev_score),
    ev_priority: text(metadata.ev_priority),
    background: text(description.background),
    combined_impact: text(description.combined_impact),
    chain: chain.map((step: any) => ({
      step: typeof step?.step === "number" || typeof step?.step === "string" ? step.step : null,
      finding: text(step?.finding),
      role: text(step?.role),
      evidence: text(step?.evidence),
    })),
  };
}

export interface ExploitPageData {
  state: ExploitPageState;
  chains: ExploitChainEntry[];
}

export async function getExploitPageData(task: DbTask, bucket: string): Promise<ExploitPageData> {
  const chainEnabled = isChainEnabled(task);
  const prefix = `scan-outputs/${task.id}/`;

  let chainTodoCount = 0;
  let reportKeys: string[] = [];
  if (chainEnabled) {
    const todos = await listObjectKeys(bucket, `${prefix}todo/`);
    chainTodoCount = todos.filter((obj) => {
      const base = obj.name.slice(`${prefix}todo/`.length);
      return !base.includes("/") && CHAIN_TODO_RE.test(base);
    }).length;
    const exploits = await listObjectKeys(bucket, `${prefix}exploits/`);
    reportKeys = exploits
      .map((obj) => obj.name)
      .filter((name) => {
        const rel = name.slice(`${prefix}exploits/`.length);
        const match = /^([^/]+)\/report\.yaml$/.exec(rel);
        return match !== null && isValidExploitId(match[1]!);
      })
      .sort();
  }

  const state = deriveExploitPageState({
    chainEnabled,
    taskState: task.state,
    chainTodoCount,
    chainReportCount: reportKeys.length,
  });

  const chains: ExploitChainEntry[] = [];
  for (const key of reportKeys) {
    const id = key.slice(`${prefix}exploits/`.length, -"/report.yaml".length);
    try {
      const raw = (await readObjectBuffer(bucket, key)).toString("utf-8");
      chains.push({ id, report: parseChainReport(raw) });
    } catch (error) {
      // One malformed chain report must not sink the whole page (H4 §2.②).
      logger.warn({ code: "WARN_CHAIN_REPORT_PARSE_FAILED", taskId: task.id, exploit_id: id, error_class: error instanceof Error ? error.name : "UnknownError" }, "Chain report parse failed; entry marked parse_error");
      chains.push({ id, parse_error: true });
    }
  }
  return { state, chains };
}

export interface ArtifactFilePreview {
  kind: ArtifactKind;
  size: number;
  language?: string;
  content?: string;
  truncated: boolean;
  mime?: string;
  data_base64?: string;
}

/** tree must come from listArtifactTree so guessed paths 404 before any fetch. */
export async function getArtifactFilePreview(taskId: string, relPath: string, tree: Set<string>, bucket: string): Promise<ArtifactFilePreview | null> {
  if (!tree.has(relPath)) return null;
  const key = `scan-outputs/${taskId}/${relPath}`;
  const buf = await readObjectBuffer(bucket, key);
  const result: CodeFileResult = await classifyCodeFileBuffer(buf, relPath, { truncatedMarker: ARTIFACT_TRUNCATED_MARKER });
  const preview: ArtifactFilePreview = {
    kind: result.type,
    size: result.size_bytes,
    truncated: result.is_truncated,
  };
  if (result.type === "text") {
    preview.language = result.language;
    preview.content = result.content;
  } else if (result.type === "image") {
    preview.mime = result.mime;
    preview.data_base64 = result.data_base64;
  } else {
    preview.mime = result.mime;
  }
  return preview;
}
