import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Decompile manifest viewer path (HALL-25 P0): `src/.vulnhunter-decompiled/manifest.json`
 * is a deterministic .class → .java contract written by
 * worker-assets/gen-decompile-manifest.py at decompile time. The viewer
 * loads it first; every failure mode (missing / corrupt / bad version /
 * hostile shape) must degrade to null so callers fall back to the
 * pre-existing three-level heuristic with zero behavior change.
 */

const m = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({
    listObjects: (_bucket: string, prefix: string) => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        for (const [key, value] of m.objects) {
          if (key.startsWith(prefix)) emitter.emit("data", { name: key, size: value.length });
        }
        emitter.emit("end");
      });
      return emitter;
    },
    getObject: async (_bucket: string, key: string) => {
      const raw = m.objects.get(key);
      if (raw === undefined) throw new Error("NoSuchKey");
      return Readable.from([raw]);
    },
  }),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  loadDecompileManifest,
  resolveClassToJavaKey,
  resolveSourceFilesKey,
  getCodeFileFromMinioKey,
} = await import("../../src/features/workspace/code-viewer.js");

const B = "b";
// unique per test: the manifest LRU cache (60s) must not bleed across tests
let taskSeq = 0;
const nextTask = () => `task-manifest-${++taskSeq}`;
let TASK = nextTask();
let P = `source-files/${TASK}/`;

function seed(key: string, content: string | Buffer) {
  m.objects.set(key, typeof content === "string" ? Buffer.from(content) : content);
}

function seedManifest(jars: unknown, version: number | string = 1) {
  seed(`${P}.vulnhunter-decompiled/manifest.json`, JSON.stringify({ version, jars }));
}

beforeEach(() => {
  m.objects.clear();
  TASK = nextTask();
  P = `source-files/${TASK}/`;
});

describe("loadDecompileManifest (defensive parsing — untrusted input)", () => {
  it("loads a valid v1 manifest", async () => {
    seedManifest([
      {
        name: "app.war",
        decompiled_root: ".vulnhunter-decompiled/app.war",
        entries: { "com/foo/Bar.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java" },
      },
    ]);
    const manifest = await loadDecompileManifest(B, TASK);
    expect(manifest?.version).toBe(1);
    expect(manifest?.jars).toHaveLength(1);
    expect(manifest?.jars[0].entries["com/foo/Bar.class"]).toContain("Bar.java");
  });

  it("returns null when the manifest is missing", async () => {
    expect(await loadDecompileManifest(B, TASK)).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    seed(`${P}.vulnhunter-decompiled/manifest.json`, "{corrupt");
    expect(await loadDecompileManifest(B, TASK)).toBeNull();
  });

  it("returns null for unsupported versions (forward compatibility)", async () => {
    seedManifest([], 2);
    expect(await loadDecompileManifest(B, TASK)).toBeNull();
    seedManifest([], "1"); // string version — not the literal number
    expect(await loadDecompileManifest(B, TASK)).toBeNull();
  });

  it("drops hostile shapes: non-object jars, missing fields, non-string entries", async () => {
    seedManifest([
      null,
      "not-an-object",
      { name: 42, decompiled_root: "x", entries: {} },
      { name: "ok.jar", decompiled_root: 7, entries: {} },
      { name: "ok2.jar", decompiled_root: ".vulnhunter-decompiled/ok2.jar", entries: { "a/A.class": 99 } },
      { name: "ok3.jar", decompiled_root: ".vulnhunter-decompiled/ok3.jar", entries: { "a/A.class": "../escape.java" } },
    ]);
    const manifest = await loadDecompileManifest(B, TASK);
    // jar blocks missing required fields dropped; hostile entries dropped per-entry
    expect(manifest?.jars.map((j) => j.name)).toEqual(["ok2.jar", "ok3.jar"]);
    const ok2 = manifest?.jars.find((j) => j.name === "ok2.jar");
    expect(Object.keys(ok2?.entries ?? {})).toEqual([]); // non-string value dropped
    const ok3 = manifest?.jars.find((j) => j.name === "ok3.jar");
    expect(Object.keys(ok3?.entries ?? {})).toEqual([]); // traversal value dropped
  });

  it("caches per task (60s LRU) — repeated loads cost one MinIO read", async () => {
    seedManifest([
      { name: "a.jar", decompiled_root: ".vulnhunter-decompiled/a.jar", entries: { "a/A.class": ".vulnhunter-decompiled/a.jar/a/A.java" } },
    ]);
    const first = await loadDecompileManifest(B, TASK);
    m.objects.delete(`${P}.vulnhunter-decompiled/manifest.json`); // vanish underneath
    const second = await loadDecompileManifest(B, TASK);
    expect(second).toBe(first);
  });
});

describe("resolveClassToJavaKey (.class request → source-files .java key)", () => {
  it("hits exact entry", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "WEB-INF/classes/com/foo/Bar.class": ".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java",
      } },
    ]);
    const hit = await resolveClassToJavaKey(B, TASK, "WEB-INF/classes/com/foo/Bar.class");
    expect(hit).toEqual({
      javaKey: `${P}.vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java`,
      javaPath: ".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java",
    });
  });

  it("resolves paths prefixed with the jar expansion root (war-extracted class files)", async () => {
    // the file tree shows the class under the extracted war root, e.g.
    // `manager-core.war/WEB-INF/classes/...` — entries keys are relative
    // to the jar root, so the resolver must also try stripping leading dirs.
    seedManifest([
      { name: "manager-core.war", decompiled_root: ".vulnhunter-decompiled/manager-core.war", entries: {
        "WEB-INF/classes/com/foo/Bar.class": ".vulnhunter-decompiled/manager-core.war/WEB-INF/classes/com/foo/Bar.java",
      } },
    ]);
    const hit = await resolveClassToJavaKey(B, TASK, "manager-core.war/WEB-INF/classes/com/foo/Bar.class");
    expect(hit?.javaKey).toBe(`${P}.vulnhunter-decompiled/manager-core.war/WEB-INF/classes/com/foo/Bar.java`);
  });

  it("internal class maps to the same outer .java (Bar$Inner.class → Bar.java)", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "com/foo/Bar.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
        "com/foo/Bar$Inner.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
      } },
    ]);
    const hit = await resolveClassToJavaKey(B, TASK, "com/foo/Bar$Inner.class");
    expect(hit?.javaPath).toBe(".vulnhunter-decompiled/app.war/com/foo/Bar.java");
  });

  it("miss → null (dependency class never decompiled)", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "com/foo/Bar.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
      } },
    ]);
    expect(await resolveClassToJavaKey(B, TASK, "WEB-INF/lib/dep/X.class")).toBeNull();
  });

  it("no manifest → null", async () => {
    expect(await resolveClassToJavaKey(B, TASK, "com/foo/Bar.class")).toBeNull();
  });

  it("returns the .java content through the MinIO-key text pipeline", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "com/foo/Bar.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
      } },
    ]);
    seed(`${P}.vulnhunter-decompiled/app.war/com/foo/Bar.java`, "class Bar { void x() {} }\n");
    const hit = await resolveClassToJavaKey(B, TASK, "com/foo/Bar.class");
    const file = await getCodeFileFromMinioKey(TASK, B, hit!.javaKey, hit!.javaPath);
    expect(file?.type).toBe("text");
    expect(file?.language).toBe("java");
    expect(file?.content).toContain("class Bar");
  });
});

describe("resolveSourceFilesKey — manifest-first deterministic hit", () => {
  it("java finding path hits the manifest reverse index before heuristics", async () => {
    seedManifest([
      { name: "a.war", decompiled_root: ".vulnhunter-decompiled/a.war", entries: {
        "com/x/A.class": ".vulnhunter-decompiled/a.war/com/x/A.java",
      } },
      { name: "b.war", decompiled_root: ".vulnhunter-decompiled/b.war", entries: {
        "com/x/A.class": ".vulnhunter-decompiled/b.war/com/x/A.java",
      } },
    ]);
    seed(`${P}.vulnhunter-decompiled/b.war/com/x/A.java`, "// b's A\n");
    // no a.war tree on MinIO — the manifest knows A.java lives under b.war
    const key = await resolveSourceFilesKey(B, TASK, "com/x/A.java");
    expect(key).toBe(`${P}.vulnhunter-decompiled/b.war/com/x/A.java`);
  });

  it("falls back to the existing heuristic when the manifest misses", async () => {
    seed(`${P}.vulnhunter-decompiled/webgoat.war/org/owasp/Lesson.java`, "class Lesson {}\n");
    const key = await resolveSourceFilesKey(B, TASK, "org/owasp/Lesson.java");
    expect(key).toBe(`${P}.vulnhunter-decompiled/webgoat.war/org/owasp/Lesson.java`);
  });
});
