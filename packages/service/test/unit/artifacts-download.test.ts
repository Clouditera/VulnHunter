import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HALL-23: download endpoints for artifacts.
 *   GET /:taskId/artifacts/file/download?path=<rel>   — single raw file
 *   GET /:taskId/findings/:findingId/artifacts/download — finding tar.gz
 *   GET /:taskId/exploits/:exploitId/artifacts/download — exploit tar.gz
 * Same mock discipline as artifacts-archive.test.ts (size decoupled from
 * content, getObject calls recorded, throwOnGet forces MinIO failure).
 */
const store = vi.hoisted(() => ({
  objects: new Map<string, { data: Buffer; size: number }>(),
  task: null as any,
  getObjectCalls: [] as string[],
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
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (_c: any, next: any) => {
    _c.set("user", { userId: "u1", tenantId: "t1", role: "member" });
    await next();
  },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: any, next: any) => await next(),
}));
vi.mock("../../src/infra/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const { artifactsRouter } = await import("../../src/features/artifacts/routes.js");

const TASK = "task-dl";
const P = `scan-outputs/${TASK}/`;

function seedTask(overrides: Record<string, unknown> = {}) {
  store.task = { id: TASK, state: "completed", source_meta: {}, ...overrides };
}

function seed(key: string, content: string | Buffer, size?: number) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  store.objects.set(key, { data, size: size ?? data.length });
}

/** Unpack a tar.gz Response body into a { relPath: content } map. */
async function unpack(res: Response): Promise<Record<string, string>> {
  const gz = Buffer.from(await res.arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), "unpack-dl-"));
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
  seedTask();
});

describe("GET /:taskId/artifacts/file/download (single raw file)", () => {
  const req = (q: string) =>
    artifactsRouter.request(`/${TASK}/artifacts/file/download?path=${encodeURIComponent(q)}`);

  it("404 for whitelist-outside, traversal, non-member paths — no existence leak", async () => {
    seed(`${P}findings/BUG-1/poc/poc.md`, "# visible\n");
    for (const q of [
      "knowledge/exploits/EXP-1.md",
      "todo/CHAIN-1.md",
      "findings/../poc.md",
      "findings/BUG-9/poc/ghost.md",
      "exploits/EXP-9/report.yaml",
      "",
    ]) {
      expect((await req(q)).status, q).toBe(404);
    }
    expect(store.getObjectCalls).toEqual([]);
  });

  it("404 for an unknown task, fetching nothing", async () => {
    store.task = null;
    const res = await req("findings/BUG-1/poc/poc.md");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "ERR_TASK_NOT_FOUND" } });
    expect(store.getObjectCalls).toEqual([]);
  });

  it("streams raw bytes with octet-stream + RFC5987 filename + content-length", async () => {
    const bin = Buffer.from([0x00, 0xff, 0x00, 0xff]);
    store.objects.set(`${P}findings/BUG-1/poc/payload.bin`, { data: bin, size: bin.length });
    const res = await req("findings/BUG-1/poc/payload.bin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''payload.bin`,
    );
    expect(res.headers.get("content-length")).toBe("4");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bin);
  });

  it("encodes non-ASCII basename per RFC 5987 (no header injection)", async () => {
    const name = "漏洞报告.md";
    store.objects.set(`${P}findings/BUG-1/poc/${name}`, { data: Buffer.from("# 中文"), size: 8 });
    const res = await req(`findings/BUG-1/poc/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    expect(await res.text()).toBe("# 中文");
  });

  it("uses only the basename even when the path is nested", async () => {
    seed(`${P}findings/BUG-1/poc/deep/nested.md`, "# deep\n");
    const res = await req("findings/BUG-1/poc/deep/nested.md");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename*=UTF-8''nested.md`,
    );
  });

  it("500 ERR_INTERNAL when MinIO getObject fails", async () => {
    seed(`${P}findings/BUG-1/poc/poc.md`, "# poc\n");
    store.throwOnGet.add(`${P}findings/BUG-1/poc/poc.md`);
    const res = await req("findings/BUG-1/poc/poc.md");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "ERR_INTERNAL" } });
  });
});

describe("GET /:taskId/findings/:findingId/artifacts/download (finding tar.gz)", () => {
  const req = (id: string) => artifactsRouter.request(`/${TASK}/findings/${id}/artifacts/download`);

  it("404 for unknown task and invalid finding ids (no existence leak)", async () => {
    store.task = null;
    expect((await req("BUG-1")).status).toBe(404);
    seedTask();
    for (const bad of ["bug-1", "BUG-", "BUG-1%2f..%2f", "RISK-1", "BUG-1/extra"]) {
      expect((await req(bad)).status, bad).toBe(404);
    }
    expect(store.getObjectCalls).toEqual([]);
  });

  it("packs only the finding's subtree, keeping task-relative paths", async () => {
    seed(`${P}findings/BUG-1/poc/poc.md`, "# poc\n");
    seed(`${P}findings/BUG-1/exp/exp.md`, "# exp\n");
    seed(`${P}findings/BUG-1/report.yaml`, "metadata: {}\n");
    seed(`${P}findings/BUG-2/poc/poc.md`, "# other\n");
    seed(`${P}exploits/EXP-1/exp.md`, "# chain\n");
    seed(`${P}knowledge/secret.md`, "never\n");

    const res = await req("BUG-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="finding-BUG-1-artifacts.tar.gz"`,
    );
    const files = await unpack(res);
    expect(Object.keys(files).sort()).toEqual([
      "findings/BUG-1/exp/exp.md",
      "findings/BUG-1/poc/poc.md",
      "findings/BUG-1/report.yaml",
    ]);
  });

  it("returns a valid empty tar.gz (200, not 404) when the finding dir is absent", async () => {
    const res = await req("BUG-404");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    const files = await unpack(res);
    expect(Object.keys(files)).toEqual([]);
    expect(store.getObjectCalls).toEqual([]);
  });

  it("413 ERR_ARCHIVE_TOO_LARGE when the finding's subtree exceeds 200MB", async () => {
    seed(`${P}findings/BUG-1/poc/big.bin`, "x", 200 * 1024 * 1024 + 1);
    const res = await req("BUG-1");
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } });
    expect(store.getObjectCalls).toEqual([]);
  });

  it("500 ERR_INTERNAL when a MinIO object read fails", async () => {
    seed(`${P}findings/BUG-1/poc/poc.md`, "# poc\n");
    store.throwOnGet.add(`${P}findings/BUG-1/poc/poc.md`);
    const res = await req("BUG-1");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "ERR_INTERNAL" } });
  });
});

describe("GET /:taskId/exploits/:exploitId/artifacts/download (exploit tar.gz)", () => {
  const req = (id: string) => artifactsRouter.request(`/${TASK}/exploits/${id}/artifacts/download`);

  it("404 for unknown task and invalid exploit ids (no existence leak)", async () => {
    store.task = null;
    expect((await req("EXP-1")).status).toBe(404);
    seedTask();
    for (const bad of ["exp-1", "EXP-", "EXP-1%2f..%2f", "EXP-1/extra"]) {
      expect((await req(bad)).status, bad).toBe(404);
    }
    expect(store.getObjectCalls).toEqual([]);
  });

  it("packs only the exploit's subtree, keeping task-relative paths", async () => {
    seed(`${P}exploits/EXP-1/exp.md`, "# exp\n");
    seed(`${P}exploits/EXP-1/report.yaml`, "metadata: {}\n");
    seed(`${P}exploits/EXP-2/exp.md`, "# other\n");
    seed(`${P}findings/BUG-1/poc/poc.md`, "# poc\n");

    const res = await req("EXP-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="exploit-EXP-1-artifacts.tar.gz"`,
    );
    const files = await unpack(res);
    expect(Object.keys(files).sort()).toEqual([
      "exploits/EXP-1/exp.md",
      "exploits/EXP-1/report.yaml",
    ]);
  });

  it("returns a valid empty tar.gz (200, not 404) when the exploit dir is absent", async () => {
    const res = await req("EXP-404");
    expect(res.status).toBe(200);
    const files = await unpack(res);
    expect(Object.keys(files)).toEqual([]);
  });

  it("413 ERR_ARCHIVE_TOO_LARGE when the exploit's subtree exceeds 200MB", async () => {
    seed(`${P}exploits/EXP-1/huge.bin`, "x", 201 * 1024 * 1024);
    const res = await req("EXP-1");
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "ERR_ARCHIVE_TOO_LARGE" } });
    expect(store.getObjectCalls).toEqual([]);
  });
});
