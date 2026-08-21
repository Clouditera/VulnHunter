import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  // minio client mock: objects map key → Buffer; listed via listObjects prefix
  objects: new Map<string, Buffer>(),
  puts: [] as string[],
  deletes: [] as string[],
  statCalls: 0,
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({
    fPutObject: vi.fn(async (_b: string, key: string, filePath: string) => {
      // read the local file content into the fake object store
      const { readFileSync } = await import("node:fs");
      m.objects.set(key, readFileSync(filePath));
      m.puts.push(key);
    }),
    removeObject: vi.fn(async (_b: string, key: string) => {
      m.objects.delete(key);
      m.deletes.push(key);
    }),
    getObject: vi.fn(async (_b: string, key: string) => {
      const buf = m.objects.get(key);
      if (!buf) throw new Error("NotFound");
      return ReadableFromBuffer(buf);
    }),
    listObjects: vi.fn((_b: string, prefix: string, _r: boolean) => {
      const keys = [...m.objects.keys()].filter((k) => k.startsWith(prefix));
      return ReadableFromStrings(keys);
    }),
  }),
}));

function ReadableFromBuffer(buf: Buffer) {
  const { Readable } = require("node:stream") as typeof import("node:stream");
  return Readable.from([buf]);
}
function ReadableFromStrings(items: string[]) {
  const { Readable } = require("node:stream") as typeof import("node:stream");
  return Readable.from(items.map((name) => ({ name })));
}

vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { uploadSourceTreeToMinio, scheduleSrcTreeSync, flushSrcTreeSync, sourceFilesPrefix } =
  await import("../../src/features/workers/src-tree-sync.js");
// scan-worker getHostWorkDir is a pure join — use the real one via the module.
const { getCodeTree, resolveSourceFilesKey, getCodeFileFromMinioKey } = await import("../../src/features/workspace/code-viewer.js");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const config = { dataDir: "", minio: { bucket: "b" } } as any;
const TASK = "11111111-2222-4333-8444-555566667777";

function makeSrcTree(): string {
  const root = mkdtempSync(join(tmpdir(), "src-tree-"));
  // emulate getHostWorkDir layout: <dataDir>/workspaces/<taskId>/src
  const ws = join(root, "workspaces", TASK);
  mkdirSync(join(ws, "src", "app"), { recursive: true });
  writeFileSync(join(ws, "src", "README.md"), "# hello\n");
  writeFileSync(join(ws, "src", "app", "Main.java"), "class Main {}\n");
  return root; // config.dataDir = root
}

describe("src-tree sync (task-c069aab9)", () => {
  beforeEach(() => {
    m.objects.clear();
    m.puts.length = 0;
    m.deletes.length = 0;
  });

  it("prepare-time upload puts the whole extracted tree", async () => {
    const stage = mkdtempSync(join(tmpdir(), "stage-"));
    writeFileSync(join(stage, "a.py"), "print(1)\n");
    mkdirSync(join(stage, "sub"));
    writeFileSync(join(stage, "sub", "b.js"), "console.log(2)\n");

    const n = await uploadSourceTreeToMinio(TASK, stage, config);
    expect(n).toBe(2);
    expect([...m.objects.keys()].sort()).toEqual([
      `source-files/${TASK}/a.py`,
      `source-files/${TASK}/sub/b.js`,
    ]);
    rmSync(stage, { recursive: true, force: true });
  });

  it("incremental sync: puts new/changed, deletes vanished, manifest survives", async () => {
    const dataDir = makeSrcTree();
    config.dataDir = dataDir;

    scheduleSrcTreeSync(TASK, config);
    await flushSrcTreeSync(TASK);
    expect(m.puts.length).toBe(2);

    // modify one file, add one, delete one
    const ws = join(dataDir, "workspaces", TASK);
    writeFileSync(join(ws, "src", "app", "Main.java"), "class Main { /* v2 */ }\n");
    writeFileSync(join(ws, "src", "app", "Util.java"), "class Util {}\n");
    rmSync(join(ws, "src", "README.md"));

    m.puts.length = 0;
    scheduleSrcTreeSync(TASK, config);
    await flushSrcTreeSync(TASK);

    expect(m.puts.sort()).toEqual([
      `source-files/${TASK}/app/Main.java`,
      `source-files/${TASK}/app/Util.java`,
    ]);
    expect(m.deletes).toEqual([`source-files/${TASK}/README.md`]);
    expect(m.objects.has(`source-files/${TASK}/README.md`)).toBe(false);
    expect(m.objects.get(`source-files/${TASK}/app/Util.java`)?.toString()).toContain("Util");

    rmSync(dataDir, { recursive: true, force: true });
  });

  it("corrupt manifest → full re-sync (no deletes)", async () => {
    const dataDir = makeSrcTree();
    config.dataDir = dataDir;
    const ws = join(dataDir, "workspaces", TASK);
    writeFileSync(join(ws, ".src-tree-manifest.json"), "{corrupt json");

    scheduleSrcTreeSync(TASK, config);
    await flushSrcTreeSync(TASK);
    expect(m.puts.length).toBe(2); // everything re-put
    expect(m.deletes.length).toBe(0); // no prior manifest → nothing to delete
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("debounce: burst of triggers costs one walk", async () => {
    const dataDir = makeSrcTree();
    config.dataDir = dataDir;
    scheduleSrcTreeSync(TASK, config);
    scheduleSrcTreeSync(TASK, config);
    scheduleSrcTreeSync(TASK, config);
    await flushSrcTreeSync(TASK);
    expect(m.puts.length).toBe(2); // one walk, both files
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("viewer: tree from source-files; key resolve direct + decompiled fallback; file read", async () => {
    // seed the object store directly (as if prepared + synced)
    const mk = (p: string, c: string) => m.objects.set(`${sourceFilesPrefix(TASK)}${p}`, Buffer.from(c));
    mk("pom.xml", "<project/>\n");
    mk(".vulnhunter-decompiled/webgoat.war/org/owasp/Lesson.java", "class Lesson { void x() {} }\n");

    const tree = await getCodeTree(TASK, "b");
    expect(tree.length).toBeGreaterThan(0);
    const names = JSON.stringify(tree);
    expect(names).toContain("pom.xml");
    expect(names).toContain(".vulnhunter-decompiled");

    // direct hit
    const k1 = await resolveSourceFilesKey("b", TASK, "pom.xml");
    expect(k1).toBe(`source-files/${TASK}/pom.xml`);

    // finding-path fallback: path relative to decompiled root
    const k2 = await resolveSourceFilesKey("b", TASK, "org/owasp/Lesson.java");
    expect(k2).toBe(`source-files/${TASK}/.vulnhunter-decompiled/webgoat.war/org/owasp/Lesson.java`);

    // file content via the MinIO-key path (text pipeline)
    const f = await getCodeFileFromMinioKey(TASK, "b", k2!, "org/owasp/Lesson.java");
    expect(f?.type).toBe("text");
    expect(f?.language).toBe("java");
    expect(f?.content).toContain("class Lesson");

    // miss → null
    expect(await resolveSourceFilesKey("b", TASK, "nope/Nope.java")).toBeNull();
  });

  it("empty source-files prefix → tree falls back to [] (caller uses legacy blob)", async () => {
    const tree = await getCodeTree("99999999-9999-4999-8999-999999999999", "b");
    expect(tree).toEqual([]);
  });
});
