import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../src/infra/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const {
  normalizeArtifactPath,
  deriveExploitPageState,
  parseChainReport,
  isChainEnabled,
  sortArtifactFiles,
  ARTIFACT_TRUNCATED_MARKER,
} = await import("../../src/features/artifacts/artifacts.js");
const { artifactsRouter } = await import("../../src/features/artifacts/routes.js");

const TASK = "task-h4";
const P = `scan-outputs/${TASK}/`;

function seedTask(overrides: Record<string, unknown> = {}) {
  store.task = { id: TASK, state: "running", source_meta: {}, ...overrides };
}

function seed(map: Record<string, string>) {
  for (const [k, v] of Object.entries(map)) store.objects.set(k, Buffer.from(v));
}

beforeEach(() => {
  store.objects.clear();
  seedTask();
});

describe("normalizeArtifactPath (whitelist root + normalization)", () => {
  it("accepts canonical findings/exploits paths", () => {
    expect(normalizeArtifactPath("findings/BUG-1/poc/poc.md")).toBe("findings/BUG-1/poc/poc.md");
    expect(normalizeArtifactPath("exploits/EXP-1/report.yaml")).toBe("exploits/EXP-1/report.yaml");
  });
  it("rejects non-whitelisted roots even when they exist", () => {
    for (const p of ["knowledge/exploits/EXP-1.md", "todo/CHAIN-1.md", "done/POC-1.md", "leads/LEAD-1.md", ".youngflow/sessions/x"]) {
      expect(normalizeArtifactPath(p)).toBeNull();
    }
  });
  it("rejects traversal, absolute, dup separators, backslash, control chars, edge segments", () => {
    for (const p of [
      "findings/../secret", "findings/./BUG-1/poc.md", "/findings/BUG-1/poc.md",
      "findings//BUG-1/poc.md", "findings\\BUG-1\\poc.md", "findings/BUG-1/",
      "findings", "findings/", "", "findings/BUG-1/\0.md",
    ] as const) {
      expect(normalizeArtifactPath(p)).toBeNull();
    }
  });
  it("treats percent sequences as literal segments (framework decodes once; membership still gates)", () => {
    // `..%2f` after one decode is a literal segment name, not a traversal;
    // it can never match a tree entry, so the preview endpoint still 404s.
    expect(normalizeArtifactPath("exploits/..%2f..%2fx")).toBe("exploits/..%2f..%2fx");
  });
});

describe("deriveExploitPageState (four-state matrix)", () => {
  const base = { chainEnabled: true, taskState: "running", chainTodoCount: 0, chainReportCount: 0 };
  it("not_enabled when chain gate off regardless of artifacts", () => {
    expect(deriveExploitPageState({ ...base, chainEnabled: false, chainTodoCount: 2, chainReportCount: 1 })).toBe("not_enabled");
  });
  it("pending when enabled but nothing dispatched yet", () => {
    expect(deriveExploitPageState(base)).toBe("pending");
  });
  it("running when CHAIN todo dispatched and no report yet", () => {
    expect(deriveExploitPageState({ ...base, chainTodoCount: 1 })).toBe("running");
  });
  it("done when at least one chain report exists", () => {
    expect(deriveExploitPageState({ ...base, chainTodoCount: 1, chainReportCount: 1 })).toBe("done");
  });
  it("done with empty chains at terminal states (attempted or never materialized)", () => {
    for (const taskState of ["completed", "failed", "cancelled"]) {
      expect(deriveExploitPageState({ ...base, taskState })).toBe("done");
      expect(deriveExploitPageState({ ...base, taskState, chainTodoCount: 2 })).toBe("done");
    }
  });
  it("non-terminal paused stays derivable", () => {
    expect(deriveExploitPageState({ ...base, taskState: "paused" })).toBe("pending");
    expect(deriveExploitPageState({ ...base, taskState: "paused", chainTodoCount: 1 })).toBe("running");
  });
});

describe("isChainEnabled (source_meta tolerant parse)", () => {
  it("true boolean or 'true' string only", () => {
    expect(isChainEnabled({ source_meta: { enable_chain: true } } as any)).toBe(true);
    expect(isChainEnabled({ source_meta: { enable_chain: "true" } } as any)).toBe(true);
    expect(isChainEnabled({ source_meta: { enable_chain: " True " } } as any)).toBe(true);
    for (const v of [false, "false", "1", 1, null, undefined]) {
      expect(isChainEnabled({ source_meta: { enable_chain: v } } as any)).toBe(false);
    }
    expect(isChainEnabled({ source_meta: {} } as any)).toBe(false);
  });
});

describe("parseChainReport (chain-report schema projection)", () => {
  const valid = `metadata:
  title: overflow + infoleak to RCE
  members: [BUG-1, BUG-2]
  cvss_score: 9.1
  ev_priority: P1
description:
  background: why combine
  combined_impact: full RCE vs single DoS
chain:
  - step: 1
    finding: BUG-2
    role: leak canary
    evidence: canary value in crash log
  - step: 2
    finding: BUG-1
    role: overflow
    evidence: rip control
`;
  it("projects the four fixed sections", () => {
    const report = parseChainReport(valid);
    expect(report.title).toBe("overflow + infoleak to RCE");
    expect(report.members).toEqual(["BUG-1", "BUG-2"]);
    expect(report.cvss_score).toBe(9.1);
    expect(report.ev_priority).toBe("P1");
    expect(report.background).toBe("why combine");
    expect(report.combined_impact).toContain("full RCE");
    expect(report.chain).toHaveLength(2);
    expect(report.chain[0]).toMatchObject({ step: 1, finding: "BUG-2", role: "leak canary" });
  });
  it("rejects malformed reports with typed errors", () => {
    for (const raw of [
      "[]", "metadata: {}", "metadata:\n  members: [BUG-1]\ndescription:\n  combined_impact: x\nchain: [1,2]",
      "metadata:\n  members: [BUG-1, BUG-2]\ndescription:\n  background: no impact\nchain:\n  - {step: 1}\n  - {step: 2}",
      "metadata:\n  members: [BUG-1, BUG-2]\ndescription:\n  combined_impact: x\nchain:\n  - {step: 1}",
    ]) {
      expect(() => parseChainReport(raw)).toThrow();
    }
  });
});

describe("sortArtifactFiles (primary doc first)", () => {
  it("poc.md/exp.md first, then alphabetical", () => {
    const files = [
      { path: "poc/zeta.sh", size: 1, kind: "text" as const, previewable: true },
      { path: "poc/poc.md", size: 1, kind: "text" as const, previewable: true },
      { path: "poc/asan.log", size: 1, kind: "text" as const, previewable: true },
    ];
    expect(sortArtifactFiles(files, "poc.md").map((f) => f.path)).toEqual(["poc/poc.md", "poc/asan.log", "poc/zeta.sh"]);
  });
});

describe("GET /:taskId/findings/:findingId/artifacts", () => {
  const req = (path: string) => artifactsRouter.request(path);

  it("404 for unknown task and invalid finding ids (no existence leak)", async () => {
    store.task = null;
    expect((await req(`/${TASK}/findings/BUG-1/artifacts`)).status).toBe(404);
    seedTask();
    for (const bad of ["bug-1", "BUG-", "BUG-1%2f..%2f", "RISK-1", "BUG-1/extra"]) {
      expect((await req(`/${TASK}/findings/${bad}/artifacts`)).status).toBe(404);
    }
  });

  it("empty groups when poc/exp dirs absent", async () => {
    const res = await req(`/${TASK}/findings/BUG-1/artifacts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ poc: { files: [] }, exp: { files: [] } });
  });

  it("lists poc/exp files with kind/previewable, primary doc first, ignores other dirs", async () => {
    seed({
      [`${P}findings/BUG-1/report.yaml`]: "metadata: {}",
      [`${P}findings/BUG-1/poc/zeta.sh`]: "#!/bin/sh\n",
      [`${P}findings/BUG-1/poc/poc.md`]: "# poc\n",
      [`${P}findings/BUG-1/poc/payload.db`]: Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]).toString("binary"),
      [`${P}findings/BUG-1/exp/exp.md`]: "# exp\n",
      [`${P}findings/BUG-1/exp/business-model.md`]: "biz\n",
      [`${P}findings/BUG-1/other/hidden.md`]: "should not appear\n",
      [`${P}findings/BUG-2/poc/other.md`]: "other finding\n",
    });
    const res = await req(`/${TASK}/findings/BUG-1/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.poc.files.map((f: any) => [f.path, f.kind, f.previewable])).toEqual([
      ["poc/poc.md", "text", true],
      ["poc/payload.db", "binary", false],
      ["poc/zeta.sh", "text", true],
    ]);
    expect(body.exp.files.map((f: any) => f.path)).toEqual(["exp/exp.md", "exp/business-model.md"]);
  });
});

describe("GET /:taskId/exploits/:exploitId/artifacts", () => {
  const req = (path: string) => artifactsRouter.request(path);

  it("404 for unknown task and invalid exploit ids (no existence leak)", async () => {
    store.task = null;
    expect((await req(`/${TASK}/exploits/EXP-1/artifacts`)).status).toBe(404);
    seedTask();
    for (const bad of ["exp-1", "EXP-", "EXP-1%2f..%2f", "EXP-1/extra", "../EXP-1"]) {
      expect((await req(`/${TASK}/exploits/${bad}/artifacts`)).status).toBe(404);
    }
  });

  it("empty files when the exploit dir is absent", async () => {
    const res = await req(`/${TASK}/exploits/EXP-1/artifacts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [] });
  });

  it("lists exploit-relative files with exp.md first, ignores nested report.yaml and other exploits", async () => {
    seed({
      [`${P}exploits/EXP-1/report.yaml`]: "metadata: {}",
      [`${P}exploits/EXP-1/exp.md`]: "# exp\n",
      [`${P}exploits/EXP-1/harness.c`]: "int main(){}",
      [`${P}exploits/EXP-1/payload.db`]: Buffer.from([0x00, 0x01]).toString("binary"),
      [`${P}exploits/EXP-2/exp.md`]: "other chain\n",
    });
    const res = await req(`/${TASK}/exploits/EXP-1/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files.map((f: any) => [f.path, f.kind, f.previewable])).toEqual([
      ["exp.md", "text", true],
      ["harness.c", "text", true],
      ["payload.db", "binary", false],
      ["report.yaml", "text", true],
    ]);
  });
});

describe("GET /:taskId/exploits", () => {
  const req = () => artifactsRouter.request(`/${TASK}/exploits`);

  it("not_enabled when enable_chain unset, even with artifacts present", async () => {
    seed({ [`${P}exploits/EXP-1/report.yaml`]: "metadata:\n  members: [BUG-1, BUG-2]\n" });
    const body = await (await req()).json();
    expect(body).toEqual({ state: "not_enabled", chains: [] });
  });

  it("pending when enabled with no CHAIN todo; running once dispatched", async () => {
    seedTask({ source_meta: { enable_chain: true } });
    expect((await (await req()).json()).state).toBe("pending");
    seed({ [`${P}todo/CHAIN-1.md`]: "status: pending\n" });
    expect((await (await req()).json()).state).toBe("running");
  });

  it("done parses chain reports; malformed one becomes parse_error without sinking the page", async () => {
    seedTask({ state: "completed", source_meta: { enable_chain: "true" } });
    seed({
      [`${P}exploits/EXP-1/report.yaml`]: `metadata:
  title: good chain
  members: [BUG-1, BUG-2]
description:
  combined_impact: bigger
chain:
  - {step: 1, finding: BUG-1, role: r1, evidence: e1}
  - {step: 2, finding: BUG-2, role: r2, evidence: e2}
`,
      [`${P}exploits/EXP-2/report.yaml`]: "metadata: {}\n",
      [`${P}exploits/EXP-3/notes.md`]: "not a report\n",
    });
    const body = await (await req()).json();
    expect(body.state).toBe("done");
    expect(body.chains).toHaveLength(2);
    expect(body.chains[0]).toMatchObject({ id: "EXP-1", report: { title: "good chain", members: ["BUG-1", "BUG-2"], combined_impact: "bigger" } });
    expect(body.chains[0].report.chain).toHaveLength(2);
    expect(body.chains[1]).toEqual({ id: "EXP-2", parse_error: true });
  });

  it("done with empty chains at terminal state without reports", async () => {
    seedTask({ state: "failed", source_meta: { enable_chain: true } });
    seed({ [`${P}todo/CHAIN-1.md`]: "status: pending\n" });
    const body = await (await req()).json();
    expect(body).toEqual({ state: "done", chains: [] });
  });
});

describe("GET /:taskId/artifacts/file", () => {
  const req = (q: string) => artifactsRouter.request(`/${TASK}/artifacts/file?path=${encodeURIComponent(q)}`);

  it("404 for whitelist-outside, traversal, non-member paths (existence never leaks)", async () => {
    seed({ [`${P}findings/BUG-1/poc/poc.md`]: "# visible\n" });
    for (const q of [
      "knowledge/exploits/EXP-1.md", "todo/CHAIN-1.md", "findings/../poc.md",
      "/findings/BUG-1/poc/poc.md", "findings//BUG-1/poc/poc.md",
      "findings/BUG-9/poc/ghost.md", "exploits/EXP-9/report.yaml",
    ]) {
      expect((await req(q)).status, q).toBe(404);
    }
  });

  it("serves text inline with language; replaces download marker with preview-only marker", async () => {
    seed({
      [`${P}findings/BUG-1/poc/poc.md`]: "# poc doc\n",
      [`${P}findings/BUG-1/poc/big.log`]: "x".repeat(1024 * 1024 + 10),
    });
    const md = await (await req("findings/BUG-1/poc/poc.md")).json();
    expect(md).toMatchObject({ kind: "text", language: "markdown", truncated: false });
    expect(md.content).toContain("# poc doc");
    const big = await (await req("findings/BUG-1/poc/big.log")).json();
    expect(big.kind).toBe("text");
    expect(big.truncated).toBe(true);
    expect(big.content.endsWith(ARTIFACT_TRUNCATED_MARKER.trim())).toBe(true);
    expect(big.content).not.toContain("download to view full");
  });

  it("serves image as base64, binary as metadata-only", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
    const bin = Buffer.from([0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff]);
    store.objects.set(`${P}findings/BUG-1/poc/shot.png`, png);
    store.objects.set(`${P}findings/BUG-1/poc/payload.bin`, bin);
    const img = await (await req("findings/BUG-1/poc/shot.png")).json();
    expect(img).toMatchObject({ kind: "image", mime: "image/png" });
    expect(img.data_base64).toBe(png.toString("base64"));
    expect(img.content).toBeUndefined();
    const payload = await (await req("findings/BUG-1/poc/payload.bin")).json();
    expect(payload.kind).toBe("binary");
    expect(payload.content).toBeUndefined();
    expect(payload.data_base64).toBeUndefined();
    expect(payload.size).toBe(8);
  });

  it("never serves another task's tree (task-scoped prefix)", async () => {
    seed({ [`scan-outputs/other-task/findings/BUG-1/poc/poc.md`]: "# theirs\n" });
    expect((await req("findings/BUG-1/poc/poc.md")).status).toBe(404);
  });
});
