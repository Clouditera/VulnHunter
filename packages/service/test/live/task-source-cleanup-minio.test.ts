import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupUnreferencedSourceArchives,
  sourceArchiveCleanupKeys,
} from "../../src/features/tasks/source-cleanup.js";
import { closeDb, getDb, initDb } from "../../src/infra/db/client.js";
import { getMinio, initMinio } from "../../src/infra/minio/client.js";

/**
 * task-10296fe2 live gate: real PostgreSQL + real MinIO, isolated ephemeral
 * containers and bucket. Kept out of the hermetic unit suite by
 * vitest.live.config.ts; run explicitly with:
 *   pnpm exec vitest --config vitest.live.config.ts run \
 *     test/live/task-source-cleanup-minio.test.ts
 */

const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const pgName = `vh-source-cleanup-pg-${suffix}`;
const minioName = `vh-source-cleanup-minio-${suffix}`;
const bucket = `source-cleanup-${randomUUID().slice(0, 12)}`;
const accessKey = "cleanupadmin";
const secretKey = "cleanup-secret-123";
let pgStarted = false;
let minioStarted = false;

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function mappedPort(container: string, port: number): number {
  const value = docker(["port", container, `${port}/tcp`]).split("\n")[0];
  const parsed = Number(value.slice(value.lastIndexOf(":") + 1));
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`invalid docker port mapping: ${value}`);
  return parsed;
}

async function eventually(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 120; i += 1) {
    try {
      if (await check()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${String(last ?? "timeout")}`);
}

async function objectExists(key: string): Promise<boolean> {
  try {
    await getMinio().statObject(bucket, key);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NotFound" || code === "NoSuchKey") return false;
    throw err;
  }
}

async function clearBucket(): Promise<void> {
  const keys = await new Promise<string[]>((resolve, reject) => {
    const found: string[] = [];
    const stream = getMinio().listObjects(bucket, "", true);
    stream.on("data", (obj) => {
      if (obj.name) found.push(obj.name);
    });
    stream.on("end", () => resolve(found));
    stream.on("error", reject);
  });
  if (keys.length > 0) await getMinio().removeObjects(bucket, keys);
}

beforeAll(async () => {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    pgName,
    "--label",
    "vulnhunter.test=task-source-cleanup",
    "-e",
    "POSTGRES_USER=cleanup",
    "-e",
    "POSTGRES_PASSWORD=cleanup-pass",
    "-e",
    "POSTGRES_DB=cleanup",
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  pgStarted = true;
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    minioName,
    "--label",
    "vulnhunter.test=task-source-cleanup",
    "-e",
    `MINIO_ROOT_USER=${accessKey}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${secretKey}`,
    "-p",
    "127.0.0.1::9000",
    "minio/minio:RELEASE.2025-09-07T16-13-09Z",
    "server",
    "/data",
    "--address",
    ":9000",
  ]);
  minioStarted = true;

  await eventually(() => {
    try {
      docker(["exec", pgName, "pg_isready", "-U", "cleanup", "-d", "cleanup"]);
      return true;
    } catch {
      return false;
    }
  }, "PostgreSQL");

  const pgPort = mappedPort(pgName, 5432);
  const minioPort = mappedPort(minioName, 9000);
  await eventually(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${minioPort}/minio/health/live`)).ok;
    } catch {
      return false;
    }
  }, "MinIO");

  process.env.MINIO_ENDPOINT = "127.0.0.1";
  process.env.MINIO_PORT = String(minioPort);
  process.env.MINIO_USE_SSL = "false";
  process.env.MINIO_ACCESS_KEY = accessKey;
  process.env.MINIO_SECRET_KEY = secretKey;
  process.env.MINIO_BUCKET = bucket;

  const databaseUrl = `postgresql://cleanup:cleanup-pass@127.0.0.1:${pgPort}/cleanup`;
  // The image briefly exposes an initialization server before its final
  // restart. Probe through the mapped host port and reset a failed singleton
  // before retrying, rather than latching that transition as a suite failure.
  await eventually(async () => {
    try {
      await initDb(databaseUrl);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await getDb()`SELECT 1`;
      return true;
    } catch {
      try {
        await closeDb();
      } catch {
        // A broken startup socket can also fail while closing; retry with a
        // fresh singleton on the next readiness iteration.
      }
      return false;
    }
  }, "PostgreSQL host connection");
  const db = getDb();
  await db`
    CREATE TABLE tasks (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      source_meta JSONB
    )
  `;
  await db`
    CREATE TABLE chat_artifacts (
      id UUID PRIMARY KEY,
      minio_key TEXT
    )
  `;
  await initMinio({
    endpoint: "127.0.0.1",
    port: minioPort,
    useSSL: false,
    accessKey,
    secretKey,
    bucket,
  });
}, 120_000);

beforeEach(async () => {
  const db = getDb();
  await db`TRUNCATE tasks, chat_artifacts`;
  await clearBucket();
});

afterAll(async () => {
  try {
    await clearBucket();
  } catch {
    /* container may already be gone */
  }
  try {
    await closeDb();
  } catch {
    /* best effort teardown */
  }
  if (minioStarted) {
    try {
      docker(["rm", "-f", minioName]);
    } catch {
      /* already removed */
    }
  }
  if (pgStarted) {
    try {
      docker(["rm", "-f", pgName]);
    } catch {
      /* already removed */
    }
  }
}, 30_000);

describe("task source cleanup against real MinIO + PostgreSQL", () => {
  it("JS-trims tabs/newlines on cross-tenant task and chat references before deleting the final reference", async () => {
    const db = getDb();
    const key = "code-packages/shared-upload.tar.gz";
    const task1 = "11111111-1111-4111-8111-111111111111";
    const task2 = "22222222-2222-4222-8222-222222222222";
    await getMinio().putObject(bucket, key, Buffer.from("shared source"));
    await db`INSERT INTO tasks (id, tenant_id, source_meta) VALUES
      (${task1}, ${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, ${db.json({ minio_key: key })}::jsonb),
      (${task2}, ${"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}, ${db.json({ code_package_key: `\t\n${key}\r\t` })}::jsonb)`;

    await db`DELETE FROM tasks WHERE id = ${task1}`;
    await cleanupUnreferencedSourceArchives([key], { taskId: task1, reason: "live-test" });
    expect(await objectExists(key)).toBe(true);

    await db`DELETE FROM tasks WHERE id = ${task2}`;
    await db`INSERT INTO chat_artifacts (id, minio_key) VALUES
      (${"33333333-3333-4333-8333-333333333333"}, ${`\n\t${key}\r`})`;
    await cleanupUnreferencedSourceArchives([key], { taskId: task2, reason: "live-test" });
    expect(await objectExists(key)).toBe(true);

    await db`DELETE FROM chat_artifacts`;
    await cleanupUnreferencedSourceArchives([key], { taskId: task2, reason: "live-test" });
    expect(await objectExists(key)).toBe(false);
  });

  it("protects every extant task's historical default key, then removes it after row deletion", async () => {
    const db = getDb();
    const taskId = "44444444-4444-4444-8444-444444444444";
    const key = `code-packages/${taskId}.zip`;
    await getMinio().putObject(bucket, key, Buffer.from("legacy source"));
    await db`INSERT INTO tasks (id, tenant_id, source_meta) VALUES
      (${taskId}, ${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, ${db.json({ minio_key: "code-packages/a-different-key.zip" })}::jsonb)`;

    await cleanupUnreferencedSourceArchives([key], { taskId: "other-task", reason: "live-test" });
    expect(await objectExists(key)).toBe(true);

    await db`DELETE FROM tasks WHERE id = ${taskId}`;
    await cleanupUnreferencedSourceArchives([key], { taskId, reason: "live-test" });
    expect(await objectExists(key)).toBe(false);
  });

  it("does not stringify malformed non-string JSON metadata into a reference", async () => {
    const db = getDb();
    const key = "code-packages/123";
    await getMinio().putObject(bucket, key, Buffer.from("malformed-meta target"));
    await db`INSERT INTO tasks (id, tenant_id, source_meta) VALUES
      (${"66666666-6666-4666-8666-666666666666"}, ${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, ${db.json({ minio_key: 123 })}::jsonb)`;

    await cleanupUnreferencedSourceArchives([key], { taskId: "deleted-task", reason: "live-test" });
    expect(await objectExists(key)).toBe(false);
  });

  it("removes only the exact recorded object and leaves same-prefix neighbors untouched", async () => {
    const taskId = "55555555-5555-4555-8555-555555555555";
    const key = "code-packages/upload-uuid.war";
    const neighbor = `${key}.keep`;
    await getMinio().putObject(bucket, key, Buffer.from("target"));
    await getMinio().putObject(bucket, neighbor, Buffer.from("neighbor"));

    const frozen = sourceArchiveCleanupKeys({
      id: taskId,
      source_meta: { minio_key: key },
    });
    await cleanupUnreferencedSourceArchives(frozen, { taskId, reason: "live-test" });
    expect(await objectExists(key)).toBe(false);
    expect(await objectExists(neighbor)).toBe(true);
  });

  it("repeated cleanup of an already-missing object remains successful", async () => {
    const key = "code-packages/already-gone.tgz";
    await cleanupUnreferencedSourceArchives([key], { taskId: "gone-task", reason: "live-test" });
    await cleanupUnreferencedSourceArchives([key], { taskId: "gone-task", reason: "live-test" });
    expect(await objectExists(key)).toBe(false);
  });
});
