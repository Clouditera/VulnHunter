#!/usr/bin/env node
/*
 * Backfill finding `title` for historical tasks by re-indexing findings from
 * MinIO YAML. The indexer now parses metadata.title; re-running it via the
 * existing reindex endpoint upserts title into findings_meta (ON CONFLICT
 * sets title = EXCLUDED.title).
 *
 * Usage:
 *   node scripts/ops/backfill-finding-title.mjs --base http://localhost:23000 \
 *     --email admin@vulnhunt.local --password admin123 [--dry-run]
 *
 * Reindexes every task with findings_indexed_at set. Idempotent (reindex is an
 * overwrite, not an increment). Requires admin credentials (reindex is admin-only
 * in production).
 *
 * Task IDs are discovered via the API (GET /api/tasks), so no DB access needed.
 */

function parseArgs(argv) {
  const args = { base: "http://localhost:23000", email: "", password: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--email") args.email = argv[++i];
    else if (a === "--password") args.password = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function getCookie(res) {
  const sc = res.headers.get("set-cookie");
  if (!sc) return "";
  return sc.split(";")[0]; // va_session=...
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.email || !args.password) {
    console.log("Usage: node scripts/ops/backfill-finding-title.mjs --base URL --email E --password P [--dry-run]");
    process.exit(args.help ? 0 : 2);
  }

  // Login
  const loginRes = await fetch(`${args.base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: args.email, password: args.password }),
  });
  if (!loginRes.ok) {
    console.error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
    process.exit(1);
  }
  const cookie = getCookie(loginRes);
  if (!cookie) { console.error("No session cookie returned"); process.exit(1); }

  // List tasks (paginate generously)
  const tasksRes = await fetch(`${args.base}/api/tasks?limit=1000`, { headers: { cookie } });
  if (!tasksRes.ok) { console.error(`List tasks failed: ${tasksRes.status}`); process.exit(1); }
  const tasksBody = await tasksRes.json();
  const tasks = (tasksBody.tasks ?? tasksBody.items ?? tasksBody ?? []).filter((t) => t.findings_indexed_at);

  console.log(`Found ${tasks.length} task(s) with indexed findings.`);
  let ok = 0, fail = 0, total = 0;
  for (const t of tasks) {
    if (args.dryRun) { console.log(`[dry-run] would reindex ${t.id} (${t.project_name ?? ""})`); continue; }
    try {
      const r = await fetch(`${args.base}/api/tasks/${t.id}/findings/reindex`, { method: "POST", headers: { cookie } });
      if (!r.ok) { console.log(`FAIL ${t.id}: ${r.status}`); fail++; continue; }
      const body = await r.json();
      total += body.indexed ?? 0;
      ok++;
      console.log(`OK   ${t.id} (${t.project_name ?? ""}) — reindexed ${body.indexed} item(s)`);
    } catch (err) {
      console.log(`FAIL ${t.id}: ${String(err)}`);
      fail++;
    }
  }
  if (!args.dryRun) console.log(`Done. ${ok} task(s) reindexed (${total} items), ${fail} failed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
