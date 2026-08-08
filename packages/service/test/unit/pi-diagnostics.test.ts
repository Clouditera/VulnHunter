import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Four-in-one CLI diagnostics tests.
 *
 * Mocks `runCredentialCliCheck` (the pi CLI subprocess runner) to inject
 * controlled event streams. Each test verifies that the four-layer
 * assertion logic correctly derives L1-L4 results from the event stream.
 */

// Mock the CLI runner — returns controlled events
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

/** Build a successful agent event stream (all four layers pass). */
function successEvents(): unknown[] {
  return [
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "I need to run ls" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "ok" },
        ],
        stopReason: "stop",
      },
    },
    {
      type: "turn_end",
      toolResults: [
        { toolName: "bash", content: [{ type: "text", text: "file1\nfile2" }] },
      ],
    },
    { type: "agent_settled" },
  ];
}

/** Events with NO thinking blocks (non-reasoning model). */
function nonReasoningEvents(): unknown[] {
  return [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          { type: "text", text: "ok" },
        ],
        stopReason: "stop",
      },
    },
    {
      type: "turn_end",
      toolResults: [
        { toolName: "bash", content: [{ type: "text", text: "output" }] },
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

describe("pi-diagnostics (four-in-one CLI)", () => {
  beforeEach(() => {
    mockRunCredentialCliCheck.mockReset();
  });

  it("all four layers pass on a successful agent circuit", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(successEvents()));
    const events: any[] = [];
    const result = await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, (e) => events.push(e));

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map((c) => c.layer)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(result.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("L1 fails when no events produced (CLI produced no output)", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult([], { stderr: "pi: command not found" }));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1); // only L1 (early stop)
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("pi: command not found");
  });

  it("L1 fails when timeout fires", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult([], { timedOut: true }));
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
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(events));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    expect(result.ok).toBe(false);
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain("HTTP 401");
    // API key scrubbed from error
    expect(result.checks[0].message).not.toContain("sk-fake-key-12345");
  });

  it("L1 stops further checks on fail (only 1 check returned)", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult([], { stderr: "connection refused" }));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    expect(result.checks).toHaveLength(1);
  });

  it("L2 is N/A for non-reasoning model (thinking_effort=off)", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(nonReasoningEvents()));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l2 = result.checks.find((c) => c.id === "thinking");
    expect(l2?.status).toBe("na");
  });

  it("L2 passes for reasoning model with thinking blocks", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(successEvents()));
    const result = await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, () => {});

    const l2 = result.checks.find((c) => c.id === "thinking");
    expect(l2?.status).toBe("pass");
  });

  it("L2 fails for reasoning model without thinking blocks", async () => {
    // Reasoning model but response has no thinking blocks
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(nonReasoningEvents()));
    const result = await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, () => {});

    const l2 = result.checks.find((c) => c.id === "thinking");
    expect(l2?.status).toBe("fail");
  });

  it("L3 passes when bash toolCall + toolResult observed", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(successEvents()));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l3 = result.checks.find((c) => c.id === "tool");
    expect(l3?.status).toBe("pass");
  });

  it("L3 fails when no tool call observed", async () => {
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
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(events));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l3 = result.checks.find((c) => c.id === "tool");
    expect(l3?.status).toBe("fail");
  });

  it("L4 passes when agent_settled and no error", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(successEvents()));
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
          content: [{ type: "text", text: "ok" }, { type: "toolCall", name: "bash", arguments: {} }],
          stopReason: "stop",
        },
      },
      {
        type: "turn_end",
        toolResults: [{ toolName: "bash", content: [{ type: "text", text: "output" }] }],
      },
      // No agent_settled
    ];
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(events));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});

    const l4 = result.checks.find((c) => c.id === "l4_agent");
    expect(l4?.status).toBe("fail");
  });

  it("emits check_started before each layer and report at end", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(successEvents()));
    const events: any[] = [];
    await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, (e) => events.push(e));

    const startedIds = events.filter((e) => e.type === "check_started").map((e) => e.check?.id);
    expect(startedIds).toContain("basic");
    expect(startedIds).toContain("thinking");
    expect(startedIds).toContain("tool");
    expect(startedIds).toContain("l4_agent");
    expect(events.some((e) => e.type === "report")).toBe(true);
  });

  it("passes credential fields to runCredentialCliCheck including advanced_config", async () => {
    mockRunCredentialCliCheck.mockResolvedValue(makeCliResult(successEvents()));
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
