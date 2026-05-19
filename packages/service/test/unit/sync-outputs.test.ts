import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const uploaded: string[] = [];
vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: () => ({ fPutObject: async (_bucket: string, objectName: string) => { uploaded.push(objectName); } }),
}));

const { syncOutputsToMinio } = await import("../../src/features/workers/sync-outputs.js");

afterEach(() => { uploaded.length = 0; });

describe("syncOutputsToMinio", () => {
  it("skips raw youngflow logs and runtime state while keeping service log", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "vh-sync-"));
    const taskId = "task-sync";
    const out = join(dataDir, "workspaces", taskId, "out");
    mkdirSync(join(out, ".youngflow", "logs"), { recursive: true });
    mkdirSync(join(out, ".youngflow", "checkpoints"), { recursive: true });
    mkdirSync(join(out, ".youngflow", "sessions"), { recursive: true });
    writeFileSync(join(out, "finding.yaml"), "ok");
    writeFileSync(join(out, ".youngflow", "logs", "youngflow.service.jsonl"), "service");
    writeFileSync(join(out, ".youngflow", "logs", "stage.events.jsonl"), "huge");
    writeFileSync(join(out, ".youngflow", "checkpoints", "state.json"), "state");
    writeFileSync(join(out, ".youngflow", "sessions", "session.json"), "session");

    const count = await syncOutputsToMinio(taskId, { dataDir, minio: { bucket: "vulnhunt" } } as any);

    expect(count).toBe(2);
    expect(uploaded).toContain("scan-outputs/task-sync/finding.yaml");
    expect(uploaded).toContain("scan-outputs/task-sync/.youngflow/logs/youngflow.service.jsonl");
    expect(uploaded.some((x) => x.includes("events.jsonl"))).toBe(false);
    expect(uploaded.some((x) => x.includes("checkpoints"))).toBe(false);
    expect(uploaded.some((x) => x.includes("sessions"))).toBe(false);
  });
});
