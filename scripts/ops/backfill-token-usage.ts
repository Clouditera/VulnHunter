#!/usr/bin/env node
/*
 * Backfill cache-aware token usage for completed tasks from YoungFlow pi session logs.
 *
 * Usage:
 *   node scripts/ops/backfill-token-usage.ts --dry-run <taskId ...>
 *   node scripts/ops/backfill-token-usage.ts <taskId ...>
 *   node scripts/ops/backfill-token-usage.ts --all-completed [--dry-run]
 *
 * By default this requires explicit task IDs. Use --all-completed to backfill
 * every completed task in the database. No environment-specific task IDs are
 * embedded in this script.
 *
 * Options:
 *   --data-dir DIR    VulnAgent DATA_DIR; defaults to .data under current cwd.
 *   --dry-run         Print summaries only; do not update DB.
 *
 * DB connection:
 *   - If DATABASE_URL is set, uses local `psql "$DATABASE_URL"`.
 *   - Otherwise uses `docker exec vulnagent-db psql -U vulnagent -d vulnagent`.
 *
 * Idempotency: updates are overwrites of derived totals, not increments.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    allCompleted: false,
    dataDir: path.join(process.cwd(), ".data"),
    taskIds: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--all-completed") args.allCompleted = true;
    else if (arg === "--data-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--data-dir requires a value");
      args.dataDir = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else args.taskIds.push(arg);
  }

  if (args.allCompleted && args.taskIds.length) {
    throw new Error("Use either --all-completed or explicit task IDs, not both");
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/backfill-token-usage.ts [--dry-run] [--data-dir DIR] <taskId ...>\n       node scripts/ops/backfill-token-usage.ts [--dry-run] [--data-dir DIR] --all-completed\n\nBackfills token fields from DATA_DIR/workspaces/<taskId>/out/.youngflow/sessions/**/session.jsonl.\nRequires explicit task IDs unless --all-completed is provided.`);
}

function dbCommand() {
  return process.env.DATABASE_URL
    ? ["psql", [process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1"]]
    : ["docker", ["exec", "-i", "vulnagent-db", "psql", "-U", "vulnagent", "-d", "vulnagent", "-v", "ON_ERROR_STOP=1"]];
}

function runDb(input) {
  const [bin, args] = dbCommand();
  const result = spawnSync(bin, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? "";
}

function listCompletedTaskIds() {
  const out = runDb("SELECT id FROM tasks WHERE state = 'completed' ORDER BY created_at;\n");
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f-]{36}$/i.test(line));
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name === "session.jsonl") out.push(p);
  }
  return out;
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function summarizeTask(taskId, dataDir) {
  const sessionsDir = path.join(dataDir, "workspaces", taskId, "out", ".youngflow", "sessions");
  const files = walk(sessionsDir);
  const sum = {
    taskId,
    sessionFiles: files.length,
    usageRecords: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalFromRecords: 0,
    warnings: [],
  };

  if (!files.length) {
    sum.warnings.push(`no session.jsonl files under ${sessionsDir}`);
    return sum;
  }

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = obj.usage || (obj.message && obj.message.usage);
      if (!usage) continue;

      const input = asNumber(usage.input ?? usage.inputTokens ?? usage.tokens_in);
      const output = asNumber(usage.output ?? usage.outputTokens ?? usage.tokens_out);
      const cacheRead = asNumber(usage.cacheRead ?? usage.cache_read ?? usage.cacheReadTokens ?? usage.tokens_cache_read);
      const cacheWrite = asNumber(usage.cacheWrite ?? usage.cache_write ?? usage.cacheWriteTokens ?? usage.tokens_cache_write);
      const total = asNumber(usage.totalTokens ?? usage.total_tokens ?? usage.tokens_total);

      sum.usageRecords += 1;
      sum.input += input;
      sum.output += output;
      sum.cacheRead += cacheRead;
      sum.cacheWrite += cacheWrite;
      sum.totalFromRecords += total;
    }
  }

  if (!sum.usageRecords) sum.warnings.push("no usage records found in session.jsonl files");
  sum.total = sum.input + sum.output + sum.cacheRead + sum.cacheWrite;
  return sum;
}

function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function buildSql(summaries) {
  const statements = ["BEGIN;"];
  for (const s of summaries) {
    if (s.warnings.length) continue;
    statements.push(`
UPDATE tasks
SET input_tokens=${s.input},
    output_tokens=${s.output},
    cache_read_tokens=${s.cacheRead},
    cache_write_tokens=${s.cacheWrite},
    total_tokens=${s.total},
    total_tokens_in=${s.input},
    total_tokens_out=${s.output},
    metadata=(
      jsonb_set(
      jsonb_set(
      jsonb_set(
      jsonb_set(
      jsonb_set(
      jsonb_set(
      jsonb_set(
        CASE
          WHEN jsonb_typeof(metadata) = 'string' THEN (metadata #>> '{}')::jsonb
          WHEN metadata IS NULL THEN '{}'::jsonb
          ELSE metadata
        END,
        '{execution,input_tokens}', to_jsonb(${s.input}::bigint), true),
        '{execution,output_tokens}', to_jsonb(${s.output}::bigint), true),
        '{execution,cache_read_tokens}', to_jsonb(${s.cacheRead}::bigint), true),
        '{execution,cache_write_tokens}', to_jsonb(${s.cacheWrite}::bigint), true),
        '{execution,total_tokens}', to_jsonb(${s.total}::bigint), true),
        '{execution,total_tokens_in}', to_jsonb(${s.input}::bigint), true),
        '{execution,total_tokens_out}', to_jsonb(${s.output}::bigint), true)
    )
WHERE id=${sqlString(s.taskId)};
`);
  }
  statements.push("COMMIT;");
  return statements.join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (!args.allCompleted && !args.taskIds.length) {
  printHelp();
  process.exit(2);
}

const taskIds = args.allCompleted ? listCompletedTaskIds() : args.taskIds;
const summaries = taskIds.map((id) => summarizeTask(id, args.dataDir));
for (const s of summaries) {
  const status = s.warnings.length ? "WARN" : "OK";
  console.log(JSON.stringify({
    status,
    taskId: s.taskId,
    sessionFiles: s.sessionFiles,
    usageRecords: s.usageRecords,
    input_tokens: s.input,
    output_tokens: s.output,
    cache_read_tokens: s.cacheRead,
    cache_write_tokens: s.cacheWrite,
    total_tokens: s.total,
    warnings: s.warnings,
  }));
}

if (args.dryRun) {
  console.log("-- dry-run: no DB updates executed");
  process.exit(0);
}

runDb(buildSql(summaries));
