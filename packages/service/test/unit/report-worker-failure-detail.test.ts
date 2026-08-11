import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logs = vi.fn();
vi.mock("../../src/features/workers/docker-client.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/features/workers/docker-client.js")>();
  return {
    ...original,
    getDocker: () => ({ getContainer: () => ({ logs }) }),
  };
});

import {
  buildReportFailureReason,
  readReportFailureDetail,
} from "../../src/features/reports/report-worker.js";

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "report-failure-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  logs.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readReportFailureDetail", () => {
  it("prefers the latest engine error from the persisted YoungFlow log", async () => {
    const root = workspace();
    const logDir = join(root, "out", ".youngflow", "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "youngflow.service.jsonl"),
      [
        '{"level":"error","message":"older error"}',
        '{"level":"info","message":"retrying"}',
        '{"level":"error","message":"upstream returned 503"}',
      ].join("\n"),
    );

    await expect(readReportFailureDetail(root, "report-1")).resolves.toContain(
      "upstream returned 503",
    );
    expect(logs).not.toHaveBeenCalled();
  });

  it("falls back to the report container logs", async () => {
    const root = workspace();
    logs.mockResolvedValue(Buffer.from("starting\n[report] FATAL: default skill missing\n"));

    await expect(readReportFailureDetail(root, "report-2")).resolves.toBe(
      "[report] FATAL: default skill missing",
    );
    expect(logs).toHaveBeenCalledWith({ stdout: true, stderr: true, tail: 50 });
  });

  it("redacts credentials and truncates the surfaced detail", async () => {
    const root = workspace();
    logs.mockResolvedValue(Buffer.from(`Error: token=super-secret ${"x".repeat(400)}`));

    const detail = await readReportFailureDetail(root, "report-3");

    expect(detail).not.toContain("super-secret");
    expect(detail).toContain("token=[REDACTED]");
    expect(detail.length).toBeLessThanOrEqual(300);
  });

  it("redacts bare sk- tokens in failure details", async () => {
    const root = workspace();
    logs.mockResolvedValue(
      Buffer.from("Error: 401 invalid api key sk-abc123def456ghi789jkl012mno"),
    );

    const detail = await readReportFailureDetail(root, "report-5");

    expect(detail).not.toContain("sk-abc123def456ghi789jkl012mno");
    expect(detail).toContain("sk-[REDACTED]");
  });

  it("keeps the legacy failure message when evidence collection yields no detail", () => {
    expect(buildReportFailureReason(1, "")).toBe("Worker exited with code 1");
    expect(buildReportFailureReason(1, "upstream returned 503")).toBe(
      "报告生成失败（退出码 1）：upstream returned 503",
    );
  });

  it("returns an empty detail when both evidence sources fail", async () => {
    const root = workspace();
    logs.mockRejectedValue(new Error("docker unavailable"));

    await expect(readReportFailureDetail(root, "report-4")).resolves.toBe("");
  });
});
