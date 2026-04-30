/**
 * Unit tests for MCP tool implementations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../../src/features/findings/storage.js", () => ({
  listFindings: vi.fn(),
  getFindingByKey: vi.fn(),
  countFindingsBySeverity: vi.fn(),
}));
vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: vi.fn(),
  listTasks: vi.fn(),
  updateTaskState: vi.fn(),
  queueTaskForResume: vi.fn(),
  resetTaskForRestart: vi.fn(),
}));
vi.mock("../../src/features/tasks/operation-lock.js", () => ({
  assertNoActiveOperation: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/workers/scan-worker.js", () => ({
  stopScanWorker: vi.fn(async () => undefined),
  cleanupScanWorkDir: vi.fn(),
}));
vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: vi.fn(),
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({ minio: { bucket: "vulnhunt" } })),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listFindings, readFinding, readTaskMetadata, listTasks, cancelTask } from "../../src/mcp/tools.js";
import * as findingsStorage from "../../src/features/findings/storage.js";
import * as taskStorage from "../../src/features/tasks/storage.js";

describe("MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("list-findings", () => {
    it("returns formatted findings list", async () => {
      vi.mocked(findingsStorage.listFindings).mockResolvedValue([
        {
          id: "1", task_id: "t1", finding_key: "BUG-001", yaml_minio_key: "k",
          severity: "high", severity_numeric: 3, vuln_type: "Buffer Overflow",
          vuln_type_full: null, cwe: "CWE-120", primary_file: "clay.h",
          primary_line: 948, function_name: "parse_header", language: "c",
          group_id: null, user_verdict: "pending",
        },
        {
          id: "2", task_id: "t1", finding_key: "BUG-002", yaml_minio_key: "k2",
          severity: "medium", severity_numeric: 2, vuln_type: "Integer Overflow",
          vuln_type_full: null, cwe: null, primary_file: "parser.c",
          primary_line: 100, function_name: null, language: "c",
          group_id: null, user_verdict: "pending",
        },
      ]);

      const result = await listFindings({ task_id: "t1" });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("BUG-001");
      expect(result.content[0].text).toContain("HIGH");
      expect(result.content[0].text).toContain("Buffer Overflow");
      expect(result.content[0].text).toContain("clay.h:948");
      expect(result.content[0].text).toContain("BUG-002");
      expect(result.content[0].text).toContain("MEDIUM");
    });

    it("returns empty message when no findings", async () => {
      vi.mocked(findingsStorage.listFindings).mockResolvedValue([]);

      const result = await listFindings({ task_id: "t1" });
      expect(result.content[0].text).toContain("No findings found");
    });

    it("passes severity filter to storage", async () => {
      vi.mocked(findingsStorage.listFindings).mockResolvedValue([]);

      await listFindings({ task_id: "t1", severity: "high", limit: 5 });

      expect(findingsStorage.listFindings).toHaveBeenCalledWith({
        taskId: "t1",
        severity: "high",
        limit: 5,
      });
    });
  });

  describe("read-finding", () => {
    it("returns not found for missing finding", async () => {
      vi.mocked(findingsStorage.getFindingByKey).mockResolvedValue(null);

      const result = await readFinding({ task_id: "t1", finding_key: "BUG-999" });
      expect(result.content[0].text).toContain("not found");
    });

    it("returns metadata fallback when MinIO fails", async () => {
      vi.mocked(findingsStorage.getFindingByKey).mockResolvedValue({
        id: "1", task_id: "t1", finding_key: "BUG-001", yaml_minio_key: "k",
        severity: "high", severity_numeric: 3, vuln_type: "Buffer Overflow",
        vuln_type_full: null, cwe: "CWE-120", primary_file: "clay.h",
        primary_line: 948, function_name: "parse_header", language: "c",
        group_id: null, user_verdict: "pending",
      });

      // getMinio throws
      const { getMinio } = await import("../../src/infra/minio/client.js");
      vi.mocked(getMinio).mockImplementation(() => { throw new Error("MinIO down"); });

      const result = await readFinding({ task_id: "t1", finding_key: "BUG-001" });
      expect(result.content[0].text).toContain("BUG-001");
      expect(result.content[0].text).toContain("HIGH");
      expect(result.content[0].text).toContain("Buffer Overflow");
    });
  });

  describe("list-tasks", () => {
    it("returns formatted task list", async () => {
      vi.mocked(taskStorage.listTasks).mockResolvedValue([
        {
          id: "t1", tenant_id: "tid", created_by: "u1",
          project_name: "clay-ui-lib", state: "completed",
          source_type: "upload", source_meta: {},
          risk_score: null, failure_reason: null,
          total_tokens_in: 0, total_tokens_out: 0,
          tool_call_count: 0, stage_count: 0,
          auto_skill_ids: [], created_at: new Date("2026-04-20"),
          started_at: null, completed_at: null,
          duration_ms: 300000, findings_indexed_at: null,
          metadata: {}, credential_id: null,
        },
      ]);

      const result = await listTasks({});
      expect(result.content[0].text).toContain("clay-ui-lib");
      expect(result.content[0].text).toContain("completed");
    });

    it("returns empty message", async () => {
      vi.mocked(taskStorage.listTasks).mockResolvedValue([]);
      const result = await listTasks({});
      expect(result.content[0].text).toContain("No tasks found");
    });
  });

  describe("cancel-task", () => {
    it("cancels a running task", async () => {
      vi.mocked(taskStorage.getTaskById).mockResolvedValue({
        id: "t1", tenant_id: "tid", created_by: "u1",
        project_name: "test", state: "running",
        source_type: "upload", source_meta: {},
        risk_score: null, failure_reason: null,
        total_tokens_in: 0, total_tokens_out: 0,
        tool_call_count: 0, stage_count: 0,
        auto_skill_ids: [], created_at: new Date(),
        started_at: new Date(), completed_at: null,
        duration_ms: null, findings_indexed_at: null,
        metadata: {}, credential_id: null,
      });
      vi.mocked(taskStorage.updateTaskState).mockResolvedValue();

      const result = await cancelTask({ task_id: "t1" });
      expect(result.content[0].text).toContain("cancelled");
      expect(taskStorage.updateTaskState).toHaveBeenCalledWith("t1", "cancelled", expect.any(Object));
    });

    it("refuses to cancel completed task", async () => {
      vi.mocked(taskStorage.getTaskById).mockResolvedValue({
        id: "t1", tenant_id: "tid", created_by: "u1",
        project_name: "test", state: "completed",
        source_type: "upload", source_meta: {},
        risk_score: null, failure_reason: null,
        total_tokens_in: 0, total_tokens_out: 0,
        tool_call_count: 0, stage_count: 0,
        auto_skill_ids: [], created_at: new Date(),
        started_at: null, completed_at: new Date(),
        duration_ms: 1000, findings_indexed_at: null,
        metadata: {}, credential_id: null,
      });

      const result = await cancelTask({ task_id: "t1" });
      expect(result.content[0].text).toContain("cannot be cancelled");
    });
  });

  describe("read-task-metadata", () => {
    it("returns not found for missing task", async () => {
      vi.mocked(taskStorage.getTaskById).mockResolvedValue(null);

      const result = await readTaskMetadata({ task_id: "no-such" });
      expect(result.content[0].text).toContain("not found");
    });

    it("returns formatted task metadata with findings counts", async () => {
      vi.mocked(taskStorage.getTaskById).mockResolvedValue({
        id: "t1", tenant_id: "tid", created_by: "u1",
        project_name: "clay-ui-lib", state: "completed",
        source_type: "upload", source_meta: {},
        risk_score: null, failure_reason: null,
        total_tokens_in: 1000, total_tokens_out: 500,
        tool_call_count: 5, stage_count: 3,
        auto_skill_ids: [], created_at: new Date("2026-04-20"),
        started_at: new Date("2026-04-20T01:00:00Z"),
        completed_at: new Date("2026-04-20T01:05:00Z"),
        duration_ms: 300000, findings_indexed_at: null,
        metadata: { language: "C", total_files: 170, total_loc: 5012, model_name: "mimo-v2-pro" },
      });

      vi.mocked(findingsStorage.countFindingsBySeverity).mockResolvedValue({
        high: 6, medium: 1, low: 4, info: 0,
      });

      const result = await readTaskMetadata({ task_id: "t1" });
      const text = result.content[0].text;

      expect(text).toContain("clay-ui-lib");
      expect(text).toContain("completed");
      expect(text).toContain("High: 6");
      expect(text).toContain("Medium: 1");
      expect(text).toContain("Low: 4");
      expect(text).toContain("Language**: C");
      expect(text).toContain("Files**: 170");
      expect(text).toContain("LOC**: 5012");
      expect(text).toContain("mimo-v2-pro");
    });
  });
});
