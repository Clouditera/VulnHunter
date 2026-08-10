import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Four-in-one CLI diagnostics tests (progressive emit, fish 2026-08-09).
 *
 * Mocks `runCredentialCliCheck` to inject controlled event streams and
 * invoke the progressive onEvent callback so mid-stream layer passes fire.
 */

const mockRunCredentialCliCheck = vi.fn();
vi.mock("../../src/features/settings/l4-agent-check.js", () => ({
  runCredentialCliCheck: (...args: unknown[]) => mockRunCredentialCliCheck(...args),
  CLI_TIMEOUT_MS: 120_000,
}));

const { runPiDiagnostics } = await import("../../src/features/settings/pi-diagnostics.js");

const FAKE_CRED = {
  id: "test-cred",
  provider: "test",
  proto_type: "openai-completions",
  base_url: "https://api.example.com/v1",
  model_id: "gpt-test",
  thinking_effort: "off" as string | undefined,
  api_key: "sk-fake-key-12345",
  context_window_tokens: 128000,
  is_default: false,
  created_at: new Date(),
  updated_at: new Date(),
} as any;

function successEvents(): unknown[] {
  return [
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "I need to read the canary" },
          { type: "toolCall", name: "read", arguments: { path: "diagnostic-canary.txt" } },
          { type: "text", text: "ok" },
        ],
        stopReason: "stop",
      },
    },
    {
      type: "turn_end",
      toolResults: [
        { toolName: "read", content: [{ type: "text", text: "VHN-DIAG-CANARY-9F3A" }] },
      ],
    },
    { type: "agent_settled" },
  ];
}

function nonReasoningEvents(): unknown[] {
  return [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "diagnostic-canary.txt" } },
          { type: "text", text: "ok" },
        ],
        stopReason: "stop",
      },
    },
    {
      type: "turn_end",
      toolResults: [
        { toolName: "read", content: [{ type: "text", text: "output" }] },
      ],
    },
    { type: "agent_settled" },
  ];
}

function makeCliResult(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    events,
    stderr: "",
    timedOut: false,
    durationMs: 1000,
    ...overrides,
  };
}

/** Mock that feeds events through onEvent then resolves (progressive path). */
function mockWithProgressive(events: unknown[], overrides: Record<string, unknown> = {}) {
  mockRunCredentialCliCheck.mockImplementation(async (_cred: unknown, opts?: { onEvent?: (e: unknown) => void }) => {
    for (const ev of events) opts?.onEvent?.(ev);
    return makeCliResult(events, overrides);
  });
}

describe("pi-diagnostics (four-in-one CLI, progressive)", () => {
  beforeEach(() => {
    mockRunCredentialCliCheck.mockReset();
  });

  it("all four layers pass on a successful agent circuit", async () => {
    mockWithProgressive(successEvents());
    const events: any[] = [];
    const result = await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, (e) => events.push(e));

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map((c) => c.layer)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("progressive: check_passed fires mid-stream before report", async () => {
    mockWithProgressive(successEvents());
    const events: any[] = [];
    await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, (e) => events.push(e));

    const types = events.map((e) => e.type);
    // All started first
    expect(types.filter((t) => t === "check_started").length).toBeGreaterThanOrEqual(3);
    // At least one progressive pass before report
    const reportIdx = types.lastIndexOf("report");
    const firstPassIdx = types.indexOf("check_passed");
    expect(firstPassIdx).toBeGreaterThanOrEqual(0);
    expect(firstPassIdx).toBeLessThan(reportIdx);
    // L1 pass should appear before L4 (order of evidence)
    const l1Pass = events.findIndex((e) => e.type === "check_passed" && e.check?.id === "basic");
    const l4Pass = events.findIndex((e) => e.type === "check_passed" && e.check?.id === "l4_agent");
    // L4 is finalized at end; L1 progressive mid-stream
    expect(l1Pass).toBeGreaterThanOrEqual(0);
    expect(l1Pass).toBeLessThan(reportIdx);
    if (l4Pass >= 0) expect(l1Pass).toBeLessThan(l4Pass);
  });

  it("L1 fails when no events produced (CLI produced no output)", async () => {
    mockWithProgressive([], { stderr: "pi: command not found" });
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    expect(result.ok).toBe(false);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("pi: command not found");
    // Progressive path still returns full 4-slot matrix (L2/L3/L4 skipped/fail)
    expect(result.checks.length).toBe(4);
  });

  it("L1 fails when timeout fires", async () => {
    mockWithProgressive([], { timedOut: true });
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    expect(result.ok).toBe(false);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("timeout");
  });

  it("L1 fails on error stopReason", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "HTTP 401 — Invalid API key",
        },
      },
    ];
    mockWithProgressive(events);
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    expect(result.ok).toBe(false);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("HTTP 401");
    expect(result.checks[0].message).not.toContain("sk-fake-key-12345");
  });

  it("L2 is N/A for non-reasoning model (thinking_effort=off)", async () => {
    mockWithProgressive(nonReasoningEvents());
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l2 = result.checks.find((c) => c.id === "thinking");
    expect(l2?.status).toBe("na");
  });

  it("L2 passes for reasoning model with thinking blocks", async () => {
    mockWithProgressive(successEvents());
    const result = await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, () => {});

    const l2 = result.checks.find((c) => c.id === "thinking");
    expect(l2?.status).toBe("pass");
  });

  it("L2 warns for reasoning model without thinking blocks (fish 2026-08-10)", async () => {
    mockWithProgressive(nonReasoningEvents());
    const result = await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, () => {});

    const l2 = result.checks.find((c) => c.id === "thinking");
    expect(l2?.status).toBe("warn");
    expect(result.ok).toBe(true);
  });

  it("L3 passes when read toolCall + toolResult observed", async () => {
    mockWithProgressive(successEvents());
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l3 = result.checks.find((c) => c.id === "tool");
    expect(l3?.status).toBe("pass");
  });

  it("L3 fails when no read tool call observed", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stopReason: "stop",
        },
      },
      { type: "agent_settled" },
    ];
    mockWithProgressive(events);
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l3 = result.checks.find((c) => c.id === "tool");
    expect(l3?.status).toBe("fail");
  });

  it("L4 passes when agent_settled and no error", async () => {
    mockWithProgressive(successEvents());
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l4 = result.checks.find((c) => c.id === "l4_agent");
    expect(l4?.status).toBe("pass");
    expect(l4?.message).toContain("agent_circuit_ok");
  });

  it("L4 fails when agent_settled not reached", async () => {
    const events = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "read", arguments: {} }],
          stopReason: "stop",
        },
      },
      {
        type: "turn_end",
        toolResults: [{ toolName: "read", content: [{ type: "text", text: "output" }] }],
      },
    ];
    mockWithProgressive(events);
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l4 = result.checks.find((c) => c.id === "l4_agent");
    expect(l4?.status).toBe("fail");
  });

  it("emits check_started for all layers up front and report at end", async () => {
    mockWithProgressive(successEvents());
    const events: any[] = [];
    await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, (e) => events.push(e));

    const startedIds = events.filter((e) => e.type === "check_started").map((e) => e.check?.id);
    expect(startedIds).toContain("basic");
    expect(startedIds).toContain("thinking");
    expect(startedIds).toContain("tool");
    expect(startedIds).toContain("l4_agent");
    // starts come before passes
    const lastStart = Math.max(...events.map((e, i) => (e.type === "check_started" ? i : -1)));
    const firstPass = events.findIndex((e) => e.type === "check_passed");
    expect(lastStart).toBeLessThan(firstPass);
    expect(events.some((e) => e.type === "report")).toBe(true);
  });

  it("passes credential fields to runCredentialCliCheck including advanced_config", async () => {
    mockWithProgressive(successEvents());
    const cred = {
      ...FAKE_CRED,
      thinking_effort: "high",
      advanced_config: { compat: { thinkingFormat: "zai" } },
    };
    await runPiDiagnostics(cred as any, () => {});

    const passedCred = mockRunCredentialCliCheck.mock.calls[0][0];
    expect(passedCred.proto_type).toBe("openai-completions");
    expect(passedCred.model_id).toBe("gpt-test");
    expect(passedCred.api_key).toBe("sk-fake-key-12345");
    expect(passedCred.advanced_config).toEqual({ compat: { thinkingFormat: "zai" } });
  });
});
