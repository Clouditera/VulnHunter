import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Dedicated mock: object size is decoupled from content length so the 200MB
// gate can be exercised without allocating real payloads. getObject calls are
// recorded to assert "no download happened" on the too-large / 404 paths, and
// a throwOnGet set forces the MinIO-failure branch.
const store = vi.hoisted(() => ({
  objects: new Map<string, { data: Buffer; size: number }>(),
  task: null as any,
  getObjectCalls: [] as string[],
  setUser: true,
  throwOnGet: new Set<string>(),
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({
    listObjects: (_bucket: string, prefix: string) => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        for (const [key, entry] of store.objects) {
          if (key.startsWith(prefix)) emitter.emit("data", { name: key, size: entry.size });
        }
        emitter.emit("end");
      });
      return emitter;
    },
    getObject: async (_bucket: string, key: string) => {
      store.getObjectCalls.push(key);
      if (store.throwOnGet.has(key)) throw new Error("MinIO down");
      const entry = store.objects.get(key);
      if (entry === undefined) throw new Error("NoSuchKey");
      return Readable.from([entry.data]);
    },
  }),
}));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: () => ({ minio: { bucket: "b" } }) }));
vi.mock("../../src/features/tasks/access.js", () => ({
  getAccessibleTask: async () => store.task,
}));
// Faithful requireAuth: rejects with 401 when no user is present, so the
// unauthenticated acceptance case is real, not stubbed away.
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (_c: any, next: any) => {
    if (store.setUser) _c.set("user", { userId: "u1", tenantId: "t1", role: "member" });
    if (!_c.get("user")) return _c.json({ error: { code: "ERR_AUTH_REQUIRED" } }, 401);
    return next();
  },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: any, next: any) => await next(),
}));
vi.mock("../../src/infra/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { artifactsRouter } = await import("../../src/features/artifacts/routes.js");

const TASK = "task-arch";
const P = `scan-outputs/${TASK}/`;
const req = () => artifactsRouter.request(`/${TASK}/artifacts/archive`);

function seedTask(overrides: Record<string, unknown> = {}) {
  store.task = { id: TASK, state: "completed", source_meta: {}, ...overrides };
}

/** Seed an object with independent reported size (defaults to content length). */
function seed(key: string, content: string | Buffer, size?: number) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  store.objects.set(key, { data, size: size ?? data.length });
}

/** Unpack a tar.gz Response body into a { relPath: content } map. */
async function unpack(res: Response): Promise<Record<string, string>> {
  const gz = Buffer.from(await res.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "unpack-"));
  const src = join(dir, "a.tar.gz");
  await writeFile(src, gz);
  await tar.x({ file: src, cwd: dir });
  const out: Record<string, string> = {};
  async function walk(rel: string) {
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries) {
      if (!rel && e.name === "a.tar.gz") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childRel);
      else out[childRel] = (await readFile(join(dir, childRel))).toString();
    }
  }
  await walk("");
  await rm(dir, { recursive: true, force: true });
  return out;
}

beforeEach(() => {
  store.objects.clear();
  store.getObjectCalls = [];
  store.throwOnGet = new Set();
  store.setUser = true;
  seedTask();
});

describe("GET /:taskId/artifacts/archive", () => {
  it("streams gzip + attachment headers and packs the exact whitelist tree", async () => {
    seed(`${P}findings/BUG-1/poc/poc.md`, "# poc\n");
    seed(`${P}findings/BUG-1/report.yaml`, "metadata: {}\n");
    seed(`${P}exploits/EXP-1/exp.md`, "# exp\n");
    seed(`${P}knowledge/secret.md`, "should never appear\n"); // outside whitelist
    seed(`scan-outputs/other-task/findings/BUG-9/poc/x.md`, "theirs\n"); // other task

    const res = await req();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="task-${TASK}-artifacts.tar.gz"`);

    const files = await unpack(res);
    expect(Object.keys(files).sort()).toEqual([
      "exploits/EXP-1/exp.md",
      "findings/BUG-1/poc/poc.md",
      "findings/BUG-1/report.yaml",
    ]);
    expect(files["findings/BUG-1/poc/poc.md"]).toBe("# poc\n");
  });

  it("returns 413 ERR_ARCHIVE_TOO_LARGE and downloads nothing when total size exceeds 200MB", async () => {
    seed(`${P}findings/BUG-1/poc/big.bin`, "x", 150 * 1024 * 1024);
    seed(`${P}exploits/EXP-1/huge.bin`, "y", 51 * 1024 * 1024);

    const res = await req();
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } });
    expect(store.getObjectCalls).toEqual([]);
  });

  it("allows total size exactly at the 200MB boundary", async () => {
    seed(`${P}findings/BUG-1/poc/at-limit.bin`, "z", 200 * 1024 * 1024);
    const res = await req();
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown or inaccessible task, downloading nothing", async () => {
    store.task = null;
    const res = await req();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "ERR_TASK_NOT_FOUND" } });
    expect(store.getObjectCalls).toEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    store.setUser = false;
    const res = await req();
    expect(res.status).toBe(401);
  });

  it("returns a valid empty tar.gz (200, not 404) when the artifact tree is empty", async () => {
    const res = await req();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const files = await unpack(res);
    expect(Object.keys(files)).toEqual([]);
    expect(store.getObjectCalls).toEqual([]);
  });

  it("returns 500 ERR_INTERNAL when a MinIO object read fails", async () => {
    seed(`${P}findings/BUG-1/poc/poc.md`, "# poc\n");
    store.throwOnGet.add(`${P}findings/BUG-1/poc/poc.md`);
    const res = await req();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "ERR_INTERNAL" } });
  });
});
