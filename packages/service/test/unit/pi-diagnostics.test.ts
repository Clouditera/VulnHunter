import { describe, expect, it, vi } from "vitest";

// Mock pi-ai streamSimple to avoid real API calls
const mockStreamSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: (...args: any[]) => mockStreamSimple(...args),
}));

const { runPiDiagnostics } = await import("../../src/features/settings/pi-diagnostics.js");
const type = import("@earendil-works/pi-ai/compat");

const FAKE_CRED = {
  id: "test-cred",
  provider: "test",
  proto_type: "openai-completions",
  base_url: "https://api.example.com/v1",
  model_id: "gpt-test",
  thinking_effort: "off" as string | undefined,
  api_key: "sk-fake",
  context_window_tokens: 128000,
  is_default: false,
  created_at: new Date(),
  updated_at: new Date(),
} as any;

function makeStream(events: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev;
    },
  };
}

describe("pi-diagnostics", () => {
  it("L1 pass when text_delta observed", async () => {
    let call = 0;
    mockStreamSimple.mockImplementation(() => {
      call++;
      // L1 and L3 both get text events; L3 will fail (no tool) but L1 should pass
      return makeStream([
        { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} },
        { type: "done", reason: "stop", message: {} },
      ]);
    });
    const events: any[] = [];
    const result = await runPiDiagnostics(FAKE_CRED, (e) => events.push(e));
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].layer).toBe("L1");
    expect(events.some((e) => e.type === "check_started" && e.check?.id === "basic")).toBe(true);
  });

  it("L1 fail stops further checks", async () => {
    mockStreamSimple.mockReturnValue(makeStream([
      { type: "error", reason: "error", error: { errorMessage: "Connection refused", stopReason: "error" } },
    ]));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1); // only L1
    expect(result.checks[0].status).toBe("fail");
  });

  it("L2 is N/A for non-reasoning model", async () => {
    mockStreamSimple.mockReturnValue(makeStream([
      { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} },
      { type: "done", reason: "stop", message: {} },
    ]));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});
    expect(result.checks.find((c) => c.id === "thinking")?.status).toBe("na");
  });

  it("L2 pass for reasoning model with thinking content", async () => {
    const reasoningCred = { ...FAKE_CRED, thinking_effort: "high", proto_type: "anthropic" };
    let call = 0;
    mockStreamSimple.mockImplementation(() => {
      call++;
      if (call === 1) return makeStream([{ type: "text_delta", delta: "4", partial: {} }, { type: "done", reason: "stop", message: {} }]);
      return makeStream([{ type: "thinking_delta", delta: "thinking...", partial: {} }, { type: "done", reason: "stop", message: {} }]);
    });
    const result = await runPiDiagnostics(reasoningCred, () => {});
    expect(result.checks.find((c) => c.id === "thinking")?.status).toBe("pass");
  });

  it("emits check_started before each check", async () => {
    mockStreamSimple.mockReturnValue(makeStream([{ type: "text_delta", delta: "ok", partial: {} }, { type: "done", reason: "stop", message: {} }]));
    const events: any[] = [];
    await runPiDiagnostics(FAKE_CRED, (e) => events.push(e));
    expect(events.some((e) => e.type === "check_started" && e.check?.id === "basic")).toBe(true);
    expect(events.some((e) => e.type === "report")).toBe(true);
  });
});
