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
  mkdirSync(join(outDir, ".youngflow", "sessions"), { recursive: true });
  writeFileSync(join(outDir, "findings", "BUG-1.yaml"), "metadata: {}\n");
  writeFileSync(join(outDir, "risks", "RISK-1.yaml"), "metadata: {}\n");
  writeFileSync(join(outDir, ".youngflow", "sessions", "session.jsonl"), "{}\n");
}

const config = { dataDir, minio: { bucket: "vulnagent" } } as never;

describe("syncOutputsToMinio includeDirs (incremental)", () => {
  beforeEach(() => { vi.clearAllMocks(); seed(); });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("full sync (no opts) uploads everything including session logs", async () => {
    const n = await syncOutputsToMinio(taskId, config);
    expect(n).toBe(3);
    const keys = fPutObject.mock.calls.map((c) => c[1]);
    expect(keys.some((k) => String(k).includes(".youngflow/sessions/"))).toBe(true);
  });

  it("incremental sync (includeDirs) uploads only findings/risks, skips session logs", async () => {
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: ["findings", "risks", "knowledge"] });
    expect(n).toBe(2);
    const keys = fPutObject.mock.calls.map((c) => String(c[1]));
    expect(keys.some((k) => k.includes("/findings/BUG-1.yaml"))).toBe(true);
    expect(keys.some((k) => k.includes("/risks/RISK-1.yaml"))).toBe(true);
    expect(keys.some((k) => k.includes(".youngflow/sessions/"))).toBe(false);
  });

  it("incremental sync tolerates missing dirs (knowledge absent)", async () => {
    const n = await syncOutputsToMinio(taskId, config, { includeDirs: ["knowledge"] });
    expect(n).toBe(0);
    expect(fPutObject).not.toHaveBeenCalled();
  });
});
