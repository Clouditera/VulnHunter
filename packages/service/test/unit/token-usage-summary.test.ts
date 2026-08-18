import { describe, expect, it } from "vitest";
import { missingCredentialFailureReason, summarizeExecutionEvents } from "../../src/features/workers/scheduler.js";

describe("summarizeExecutionEvents", () => {
  it("summarizes cache-aware stage_done token usage", () => {
    const summary = summarizeExecutionEvents([
      JSON.stringify({
        event: "stage_done",
        tokens_in: 10,
        tokens_out: 3,
        tokens_cache_read: 100,
        tokens_cache_write: 5,
        tokens_total: 118,
        tools: 2,
      }),
      JSON.stringify({ event: "flow_end", stages_total: 1, stages_completed: 1, stages_failed: 0 }),
    ]);

    expect(summary).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
      totalTokens: 118,
      toolCallCount: 2,
      stageCount: 1,
      flowStagesTotal: 1,
      flowStagesCompleted: 1,
      flowStagesFailed: 0,
    });
  });

  it("LEGACY (finalizer retired 2026-08-18): accumulates two-phase stage totals instead of accepting the finalizer flow_end=1 overwrite", () => {
    const summary = summarizeExecutionEvents([
      JSON.stringify({ event: "stage_done", stage: "decide", exit_code: 0, tokens_total: 10, tools: 2 }),
      JSON.stringify({ event: "stage_done", stage: "verify/A", exit_code: 1, tokens_total: 20, tools: 3 }),
      JSON.stringify({ event: "flow_end", stages_total: 2, stages_completed: 1, stages_failed: 1 }),
      JSON.stringify({ event: "stage_done", stage: "report", exit_code: 0, tokens_total: 30, tools: 4 }),
      JSON.stringify({ event: "flow_end", stages_total: 1, stages_completed: 1, stages_failed: 0 }),
    ]);

    expect(summary).toMatchObject({
      stageCount: 3,
      flowStagesTotal: 3,
      flowStagesCompleted: 2,
      flowStagesFailed: 1,
      totalTokens: 60,
      toolCallCount: 9,
    });
  });

  it("falls back to input plus output for old stage_done events", () => {
    const summary = summarizeExecutionEvents([
      JSON.stringify({ event: "stage_done", tokens_in: 10, tokens_out: 3, tools: 2 }),
    ]);

    expect(summary.cacheReadTokens).toBe(0);
    expect(summary.cacheWriteTokens).toBe(0);
    expect(summary.totalTokens).toBe(13);
  });

  it("uses computed four-field total when emitted total is lower", () => {
    const summary = summarizeExecutionEvents([
      JSON.stringify({
        event: "stage_done",
        tokens_in: 10,
        tokens_out: 3,
        tokens_cache_read: 100,
        tokens_cache_write: 5,
        tokens_total: 1,
      }),
    ]);

    expect(summary.totalTokens).toBe(118);
  });
});

describe("missingCredentialFailureReason", () => {
  it("returns a terminal user-facing reason for old queued tasks without credentials", () => {
    expect(missingCredentialFailureReason(null)).toContain("任务缺少可用模型凭证");
  });

  it("returns a terminal user-facing reason for deleted credential references", () => {
    expect(missingCredentialFailureReason("cred-missing")).toContain("指定的模型凭证不存在或已不可用");
  });
});
