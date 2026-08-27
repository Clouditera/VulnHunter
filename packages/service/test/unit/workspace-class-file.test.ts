import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /workspace/file .class handling (HALL-25 P0): a .class request is
 * first resolved through the decompile manifest. On a hit the endpoint
 * returns the .java content plus the new OPTIONAL fields
 * `decompiled_from` / `resolved_path`. Every miss (no manifest, corrupt
 * manifest, dependency class) keeps the exact pre-existing behavior —
 * the three-level fallback, then the binary view. Backward compatibility
 * is a hard requirement: old tasks behave identically.
 */

const store = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  task: null as any,
}));

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({
    listObjects: (_bucket: string, prefix: string) => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        for (const [key, value] of store.objects) {
          if (key.startsWith(prefix)) emitter.emit("data", { name: key, size: value.length });
        }
        emitter.emit("end");
      });
      return emitter;
    },
    getObject: async (_bucket: string, key: string) => {
      const raw = store.objects.get(key);
      if (raw === undefined) throw new Error("NoSuchKey");
      return Readable.from([raw]);
    },
  }),
}));
vi.mock("../../src/infra/config.js", () => ({ loadConfig: () => ({ minio: { bucket: "b" } }) }));
vi.mock("../../src/features/tasks/access.js", () => ({
  getAccessibleTask: async () => store.task,
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: async (_c: any, next: any) => { _c.set("user", { userId: "u1", role: "admin" }); await next(); },
}));
vi.mock("../../src/middleware/license-guard.js", () => ({
  licenseGuard: async (_c: any, next: any) => await next(),
}));
vi.mock("../../src/infra/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { workspaceRouter } = await import("../../src/features/workspace/routes.js");

// getCodeFile (legacy blob path) must never be reached in these scenarios;
// when it is (fallback case), it 404s naturally via the archive reader.
const TASK = "task-classview-1";
const P = `source-files/${TASK}/`;
// unique task per test: the code-file cache (1h) must not bleed across tests
let taskSeq = 0;
const nextTask = () => `task-classview-${++taskSeq}`;
let CUR = TASK;
let CUP = P;

function seed(key: string, content: string | Buffer) {
  store.objects.set(key.replace(P, CUP), typeof content === "string" ? Buffer.from(content) : content);
}

function seedManifest(jars: unknown, version: number | string = 1) {
  seed(`${P}.vulnhunter-decompiled/manifest.json`, JSON.stringify({ version, jars }));
}

beforeEach(() => {
  store.objects.clear();
  CUR = nextTask();
  CUP = `source-files/${CUR}/`;
  store.task = { id: CUR, state: "completed", source_meta: {} };
});

const file = (path: string) => workspaceRouter.request(`/${CUR}/workspace/file?path=${encodeURIComponent(path)}`);

describe("GET /:taskId/workspace/file — .class manifest resolution (HALL-25)", () => {
  it("manifest hit: returns .java content + decompiled_from/resolved_path", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "WEB-INF/classes/com/foo/Bar.class": ".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java",
        "WEB-INF/classes/com/foo/Bar$Inner.class": ".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java",
      } },
    ]);
    seed(`${P}.vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java`, "class Bar { void x() {} }\n");

    const res = await file("WEB-INF/classes/com/foo/Bar.class");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("text");
    expect(body.language).toBe("java");
    expect(body.content).toContain("class Bar");
    expect(body.decompiled_from).toBe("WEB-INF/classes/com/foo/Bar.class");
    expect(body.resolved_path).toBe(".vulnhunter-decompiled/app.war/WEB-INF/classes/com/foo/Bar.java");
  });

  it("inner class request resolves to the outer .java and reports the .class origin", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "com/foo/Bar.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
        "com/foo/Bar$Inner.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
      } },
    ]);
    seed(`${P}.vulnhunter-decompiled/app.war/com/foo/Bar.java`, "class Bar { class Inner {} }\n");

    const res = await file("com/foo/Bar$Inner.class");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("class Bar");
    expect(body.decompiled_from).toBe("com/foo/Bar$Inner.class");
  });

  it("no manifest: .class falls through unchanged — binary view, no new fields", async () => {
    // old task: no manifest, no decompiled tree — the .class sits in the
    // source-files tree as a binary object
    seed(`${P}WEB-INF/classes/com/foo/Bar.class`, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x01, 0x00, 0x02]));

    const res = await file("WEB-INF/classes/com/foo/Bar.class");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("binary");
    expect(body.decompiled_from).toBeUndefined();
    expect(body.resolved_path).toBeUndefined();
  });

  it("corrupt manifest: silent fallback, binary view, no error", async () => {
    seed(`${P}.vulnhunter-decompiled/manifest.json`, "{corrupt");
    seed(`${P}com/foo/Bar.class`, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00]));

    const res = await file("com/foo/Bar.class");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("binary");
    expect(body.decompiled_from).toBeUndefined();
  });

  it("manifest present but class not decompiled (dependency): binary view, no new fields", async () => {
    seedManifest([
      { name: "app.war", decompiled_root: ".vulnhunter-decompiled/app.war", entries: {
        "com/foo/Bar.class": ".vulnhunter-decompiled/app.war/com/foo/Bar.java",
      } },
    ]);
    seed(`${P}.vulnhunter-decompiled/app.war/com/foo/Bar.java`, "class Bar {}\n");
    // dependency class exists in the tree but was never decompiled
    seed(`${P}WEB-INF/lib/dep/X.class`, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00]));

    const res = await file("WEB-INF/lib/dep/X.class");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("binary");
    expect(body.decompiled_from).toBeUndefined();
    expect(body.resolved_path).toBeUndefined();
  });

  it("non-.class requests are untouched: direct text hit without new fields", async () => {
    seed(`${P}src/Main.java`, "class Main {}\n");
    const res = await file("src/Main.java");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("text");
    expect(body.decompiled_from).toBeUndefined();
  });

  it("404 when nothing resolves", async () => {
    const res = await file("nope/Nothing.class");
    expect(res.status).toBe(404);
  });
});
