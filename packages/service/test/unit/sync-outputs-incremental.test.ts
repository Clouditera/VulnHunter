import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fPutObject = vi.fn(async () => undefined);

vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({ fPutObject }),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/features/workers/docker-client.js", () => ({
  ensureWorkDir: vi.fn(),
}));

const { syncOutputsToMinio } = await import("../../src/features/workers/sync-outputs.js");

const dataDir = mkdtempSync(join(tmpdir(), "va-sync-test-"));
const taskId = "task-1";

// getHostWorkDir(dataDir, taskId) → <dataDir>/workspaces/<taskId>
const outDir = join(dataDir, "workspaces", taskId, "out");

function seed() {
  rmSync(join(dataDir, "workspaces"), { recursive: true, force: true });
  mkdirSync(join(outDir, "findings"), { recursive: true });
  mkdirSync(join(outDir, "risks"), { recursive: true });
  mkdirSync(join(outDir, "knowledge"), { recursive: true });
  mkdirSync(join(outDir, "agenda"), { recursive: true });
  mkdirSync(join(outDir, "leads"), { recursive: true });
  mkdirSync(join(outDir, ".youngflow", "sessions"), { recursive: true });
  writeFileSync(join(outDir, "findings", "BUG-1.yaml"), "metadata: {}\n");
  writeFileSync(join(outDir, "risks", "RISK-1.yaml"), "metadata: {}\n");
  writeFileSync(join(outDir, "knowledge", "sink-ledger.md"), "# sinks\n");
  writeFileSync(join(outDir, "agenda", "queue.yaml"), "items: []\n");
  writeFileSync(join(outDir, "leads", "lead.yaml"), "items: []\n");
  writeFileSync(join(outDir, ".youngflow", "sessions", "session.jsonl"), "{}\n");
}

const config = { dataDir, minio: { bucket: "artifact-store" } } as never;

describe("syncOutputsToMinio includeDirs (incremental)", () => {
  beforeEach(() => { vi.clearAllMocks(); seed(); });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("full terminal sync (no opts) uploads all artifacts including agenda/leads/sink-ledger and session logs", async () => {
    const n = await syncOutputsToMinio(taskId, config);
    expect(n).toBe(6);
    const keys = fPutObject.mock.calls.map((c) => String(c[1]));
    expect(keys.some((k) => k.includes("/agenda/queue.yaml"))).toBe(true);
    expect(keys.some((k) => k.includes("/leads/lead.yaml"))).toBe(true);
    expect(keys.some((k) => k.includes("/knowledge/sink-ledger.md"))).toBe(true);
    expect(keys.some((k) => k.includes(".youngflow/sessions/"))).toBe(true);
  });

  it("incremental sync (includeDirs) uploads only selected lightweight dirs, skips session logs", async () => {
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: ["findings", "risks", "knowledge"] });
    expect(n).toBe(3);
    const keys = fPutObject.mock.calls.map((c) => String(c[1]));
    expect(keys.some((k) => k.includes("/findings/BUG-1.yaml"))).toBe(true);
    expect(keys.some((k) => k.includes("/risks/RISK-1.yaml"))).toBe(true);
    expect(keys.some((k) => k.includes("/knowledge/sink-ledger.md"))).toBe(true);
    expect(keys.some((k) => k.includes("/agenda/"))).toBe(false);
    expect(keys.some((k) => k.includes("/leads/"))).toBe(false);
    expect(keys.some((k) => k.includes(".youngflow/sessions/"))).toBe(false);
  });

  it("incremental sync tolerates missing selected dirs", async () => {
    rmSync(join(outDir, "knowledge"), { recursive: true, force: true });
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: ["knowledge"] });
    expect(n).toBe(0);
    expect(fPutObject).not.toHaveBeenCalled();
  });
});
