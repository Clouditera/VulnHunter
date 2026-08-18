/**
 * Output Contract Extension
 *
 * Enforces output contracts for flow stages via three hooks:
 *
 *   tool_call:  strict mode blocks writes not matching any contract rule
 *   tool_result: schema-validates written files immediately, reports to model
 *   turn_end:   when model stops calling tools, validates all rules;
 *               on failure, steers the model back (prevents exit)
 *
 * Environment variables (set by YoungFlow engine):
 *   YOUNGFLOW_STAGE_ID    - current stage id
 *   YOUNGFLOW_OUTPUT_DIR  - output root (patterns resolve relative to this)
 *   YOUNGFLOW_FLOW_DIR    - flow asset dir (schema paths resolve relative to this)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { resolve, relative, join, basename, dirname } from "node:path";
import YAML from "yaml";
import Ajv from "ajv";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContractRule {
  pattern: string;
  schema?: string;
  chinese_check?: boolean;
  min_count?: number;
}

interface StageContract {
  strict?: boolean;
  max_retries?: number;
  rules: ContractRule[];
}

interface PathCtx {
  outputDir: string;
  flowDir: string;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const stageId = process.env.YOUNGFLOW_STAGE_ID;
  const outputDir = process.env.YOUNGFLOW_OUTPUT_DIR;
  const flowDir = process.env.YOUNGFLOW_FLOW_DIR;

  if (!stageId || !outputDir || !flowDir) return;

  const contractsPath = resolve(__dirname, "contracts.json");
  if (!existsSync(contractsPath)) return;

  let contracts: Record<string, StageContract>;
  try {
    contracts = JSON.parse(readFileSync(contractsPath, "utf-8"));
  } catch (e) {
    console.error(`[output-contract] Failed to parse contracts.json: ${e}`);
    return;
  }

  const contract = contracts[stageId] ?? contracts[stageId.split("/")[0]];
  if (!contract?.rules?.length) return;

  const ctx: PathCtx = { outputDir, flowDir };
  const strict = contract.strict ?? false;
  const maxRetries = contract.max_retries ?? 2;
  let attempts = 0;

  // -----------------------------------------------------------------------
  // Hook 1: tool_call — strict mode blocks non-contract writes
  // -----------------------------------------------------------------------
  //
  // Artifact IDs are assigned by the model per the naming rules in each
  // task prompt (e.g. HYP-R{round}-C{cog}-A{adv}-H{hyp}). Cross-worker
  // collisions are prevented structurally: each map worker consumes a
  // distinct input file, so its outputs carry a distinct ID prefix.
  // Frontmatter id format is enforced by the schema bound in contracts.json.

  pi.on("tool_call", async (event) => {
    let targetPath: string | undefined;

    if (isToolCallEventType("write", event)) {
      targetPath = event.input.path;
    } else if (isToolCallEventType("edit", event)) {
      targetPath = event.input.path;
    }

    if (!targetPath) return;
    if (targetPath.startsWith("@")) targetPath = targetPath.slice(1);

    const relPath = toRelative(resolve(process.cwd(), targetPath), ctx);

    if (relPath !== null && matchesAnyRule(relPath, contract.rules)) {
      return; // within contract
    }

    if (strict) {
      const allowed = contract.rules.map((r) => `  - ${r.pattern}`).join("\n");
      return {
        block: true,
        reason:
          `[output-contract] Blocked: '${targetPath}' is not in the output contract.\n` +
          `Allowed output patterns:\n${allowed}\n` +
          `Only files matching these patterns may be written.`,
      };
    }
  });

  // -----------------------------------------------------------------------
  // Hook 2: tool_result — schema-validate after successful write/edit
  // -----------------------------------------------------------------------

  pi.on("tool_result", async (event) => {
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const rawPath = (event.input as { path?: string })?.path;
    if (!rawPath) return;

    const cleanPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
    const absPath = resolve(process.cwd(), cleanPath);
    const relPath = toRelative(absPath, ctx);
    if (relPath === null) return;

    const rule = matchesAnyRule(relPath, contract.rules);
    if (!rule?.schema) return;

    const errors = validateSchema(absPath, rule.schema, ctx);
    if (errors.length === 0) return;

    const schemaAbsPath = resolve(ctx.flowDir, rule.schema);
    const errText =
      `\n⚠️ Output contract schema validation failed for '${basename(absPath)}':\n` +
      errors.map((e) => `  - ${e}`).join("\n") +
      `\nSchema: ${schemaAbsPath}` +
      `\nPlease fix the file content to match the schema.`;

    return {
      content: [...(event.content ?? []), { type: "text" as const, text: errText }],
      isError: true,
    };
  });

  // -----------------------------------------------------------------------
  // Hook 3: turn_end — validate when model stops calling tools
  //
  // Key insight: turn_end fires INSIDE the agent loop. Right after turn_end,
  // the loop calls getSteeringMessages(). If we steer() here, the message
  // is picked up immediately and the loop continues — preventing exit.
  //
  // agent_end fires AFTER the loop exits, too late for followUp to work.
  // -----------------------------------------------------------------------

  pi.on("turn_end", async (event) => {
    // Only validate when the model stops making tool calls
    const hasToolCalls = event.message?.content?.some(
      (c: { type: string }) => c.type === "toolCall"
    );
    if (hasToolCalls) return; // still working

    if (attempts >= maxRetries) return; // give up

    const errors = validateAllRules(contract.rules, ctx);

    if (errors.length === 0) {
      console.error(`[output-contract] ${stageId}: all rules passed`);
      return;
    }

    attempts++;
    console.error(
      `[output-contract] ${stageId}: ${errors.length} violation(s) (attempt ${attempts}/${maxRetries}):\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );

    if (attempts >= maxRetries) {
      console.error(`[output-contract] ${stageId}: giving up after ${maxRetries} attempts`);
      return;
    }

    const msg = [
      "⚠️ **Output Contract Validation Failed**",
      "",
      ...errors.map((e, i) => `${i + 1}. ${e}`),
      "",
      "Please fix the above issues before finishing.",
    ].join("\n");

    // steer: injected into the agent loop's steering queue,
    // drained on the very next line after turn_end, loop continues
    pi.sendUserMessage(msg, { deliverAs: "steer" });
  });
}

// ---------------------------------------------------------------------------
// Full validation (for turn_end exit check)
// ---------------------------------------------------------------------------

function validateAllRules(rules: ContractRule[], ctx: PathCtx): string[] {
  const errors: string[] = [];

  for (const rule of rules) {
    const files = globMatch(ctx.outputDir, rule.pattern);

    const minCount = rule.min_count ?? 1;
    if (files.length < minCount) {
      if (minCount > 0) {
        errors.push(`Missing: \`${rule.pattern}\` — found ${files.length}, need ≥${minCount}`);
      }
      if (files.length === 0) continue;
    }

    if (rule.schema) {
      for (const file of files) {
        const schemaErrors = validateSchema(file, rule.schema, ctx);
        if (schemaErrors.length > 0) {
          const schemaPath = resolve(ctx.flowDir, rule.schema);
          for (const e of schemaErrors) {
            errors.push(`Schema: \`${basename(file)}\` — ${e} (schema: ${schemaPath})`);
          }
        }
      }
    }

    if (rule.chinese_check) {
      for (const file of files) {
        try {
          if (!/[\u4e00-\u9fff]/.test(readFileSync(file, "utf-8"))) {
            errors.push(`Chinese: \`${basename(file)}\` — no Chinese characters found`);
          }
        } catch {
          errors.push(`Unreadable: \`${file}\``);
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toRelative(absPath: string, ctx: PathCtx): string | null {
  const rel = relative(ctx.outputDir, absPath);
  if (rel.startsWith("..") || resolve(ctx.outputDir, rel) !== absPath) return null;
  return rel;
}

function matchesAnyRule(relPath: string, rules: ContractRule[]): ContractRule | null {
  for (const rule of rules) {
    if (patternMatches(relPath, rule.pattern)) return rule;
  }
  return null;
}

function patternMatches(relPath: string, pattern: string): boolean {
  const normRel = relPath.replace(/\\/g, "/");
  const normPat = pattern.replace(/\\/g, "/");

  // Build a full-path regex with proper glob semantics:
  //   **/  -> zero or more path segments (so a/**/c.md matches a/c.md and a/b/c.md)
  //   **   -> any characters including '/'
  //   *    -> any characters except '/'
  //   ?    -> a single character except '/'
  let re = "";
  for (let i = 0; i < normPat.length; i++) {
    const c = normPat[i];
    if (c === "*") {
      if (normPat[i + 1] === "*") {
        // consume the second '*'
        i++;
        if (normPat[i + 1] === "/") {
          // '**/' — zero or more path segments
          i++;
          re += "(?:[^/]+/)*";
        } else {
          // trailing/embedded '**' — anything including '/'
          re += ".*";
        }
      } else {
        // single '*' — anything except '/'
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      // escape regex metacharacters
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$").test(normRel);
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateSchema(filePath: string, schemaRel: string, ctx: PathCtx): string[] {
  const schemaPath = resolve(ctx.flowDir, schemaRel);

  if (!existsSync(schemaPath)) return [`schema file not found: ${schemaRel}`];
  if (!existsSync(filePath)) return [`file not found: ${filePath}`];

  try {
    let content = readFileSync(filePath, "utf-8");

    // Extract YAML frontmatter from Markdown files
    if (filePath.endsWith(".md")) {
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return [`no YAML frontmatter found in ${basename(filePath)}`];
      content = fmMatch[1];
    }

    const data = YAML.parse(content);
    const schema = YAML.parse(readFileSync(schemaPath, "utf-8"));
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (validate(data)) return [];
    return (validate.errors ?? []).map((e) => {
      const path = e.instancePath || "(root)";
      return `${path}: ${e.message}`;
    });
  } catch (e: any) {
    return [`parse error: ${e.message ?? e}`];
  }
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

function globMatch(baseDir: string, pattern: string): string[] {
  // Collect all files under baseDir, then filter by patternMatches on the
  // relative path. This gives correct '**' (zero-or-more dirs) semantics and
  // keeps a single source of truth for matching.
  const results: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) return;
      entries = readdirSync(dir);
    } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(full).isDirectory(); } catch { continue; }
      if (isDir) {
        walk(full);
      } else {
        const rel = full.slice(baseDir.length).replace(/^\//, "");
        if (patternMatches(rel, pattern)) results.push(full);
      }
    }
  };
  if (existsSync(baseDir)) walk(baseDir);
  return results;
}
