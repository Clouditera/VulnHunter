import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock pi-ai streamSimple to avoid real API calls (L2/L3 use streams).
const mockStreamSimple = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: (...args: any[]) => mockStreamSimple(...args),
}));

// L1 uses a direct undici fetch (QA-proven pi-ai swallows network errors).
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okFetch(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
  beforeEach(() => {
    mockFetch.mockReset();
    mockStreamSimple.mockReset();
  });

  it("L1 pass on 2xx from the direct fetch", async () => {
    mockFetch.mockResolvedValue(okFetch());
    const events: any[] = [];
    const result = await runPiDiagnostics(FAKE_CRED, (e) => events.push(e));
    expect(result.checks[0].status).toBe("pass");
    expect(result.checks[0].layer).toBe("L1");
    expect(events.some((e) => e.type === "check_started" && e.check?.id === "basic")).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("L1 fail carries HTTP status + gateway body verbatim and stops further checks", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Model Not Exist" } }), { status: 400 }));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1); // only L1
    expect(result.checks[0].status).toBe("fail");
    expect(result.checks[0].message).toContain('HTTP 400 — {"error":{"message":"Model Not Exist"}}');
  });

  it("L1 sends Anthropic contract headers for anthropic proto (not Bearer)", async () => {
    mockFetch.mockResolvedValue(okFetch());
    const anthropicCred = { ...FAKE_CRED, proto_type: "anthropic" };
    await runPiDiagnostics(anthropicCred, () => {});
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-fake");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Authorization"]).toBeUndefined();
    // Anthropic /messages REQUIRES max_tokens — give the thinking budget
    // (32768) + 4096 margin (architect 2026-08-06); NOT the old self-imposed 16.
    expect(String(init.body)).toContain('"max_tokens":36864');
  });

  it("L1 openai-completions body carries NO max_tokens (gateway default output cap)", async () => {
    mockFetch.mockResolvedValue(okFetch());
    await runPiDiagnostics(FAKE_CRED, () => {});
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain("max_tokens");
    expect(String(init.body)).not.toContain("max_output_tokens");
  });

  it("L1 openai-responses body carries NO max_output_tokens", async () => {
    mockFetch.mockResolvedValue(okFetch());
    await runPiDiagnostics({ ...FAKE_CRED, proto_type: "openai-responses" }, () => {});
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain("max_tokens");
    expect(String(init.body)).not.toContain("max_output_tokens");
  });

  it("L1 fail carries the undici network cause (ENOTFOUND via err.cause)", async () => {
    const netErr: any = new TypeError("fetch failed");
    netErr.cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.typo-host.com" };
    mockFetch.mockRejectedValue(netErr);
    const result = await runPiDiagnostics(FAKE_CRED, () => {});
    expect(result.ok).toBe(false);
    expect(result.checks[0].message).toContain("ENOTFOUND getaddrinfo ENOTFOUND api.typo-host.com");
  });

  it("L2 is N/A for non-reasoning model", async () => {
    mockFetch.mockResolvedValue(okFetch());
    mockStreamSimple.mockReturnValue(makeStream([
      { type: "text_delta", contentIndex: 0, delta: "ok", partial: {} },
      { type: "done", reason: "stop", message: {} },
    ]));
    const result = await runPiDiagnostics(FAKE_CRED, () => {});
    expect(result.checks.find((c) => c.id === "thinking")?.status).toBe("na");
  });

  it("L2 pass for reasoning model with thinking content", async () => {
    const reasoningCred = { ...FAKE_CRED, thinking_effort: "high", proto_type: "anthropic" };
    mockFetch.mockResolvedValue(okFetch());
    mockStreamSimple.mockImplementation(() =>
      makeStream([{ type: "thinking_delta", delta: "thinking...", partial: {} }, { type: "done", reason: "stop", message: {} }]),
    );
    const result = await runPiDiagnostics(reasoningCred, () => {});
    expect(result.checks.find((c) => c.id === "thinking")?.status).toBe("pass");
  });

  it("emits check_started before each check", async () => {
    mockFetch.mockResolvedValue(okFetch());
    mockStreamSimple.mockReturnValue(makeStream([{ type: "text_delta", delta: "ok", partial: {} }, { type: "done", reason: "stop", message: {} }]));
    const events: any[] = [];
    await runPiDiagnostics(FAKE_CRED, (e) => events.push(e));
    expect(events.some((e) => e.type === "check_started" && e.check?.id === "basic")).toBe(true);
    expect(events.some((e) => e.type === "report")).toBe(true);
  });
});

describe("pi-diagnostics buildModel shape", () => {
  it("buildModel output has all required Model fields", async () => {
    // Re-import to get buildModel — it's not exported, so test indirectly
    // via the stream: if input/cost/contextWindow/maxTokens are missing,
    // pi-ai internals crash on .includes(). The mock below asserts the
    // model object passed to streamSimple has all required fields.
    const passedModel: any[] = [];
    mockFetch.mockResolvedValue(okFetch());
    mockStreamSimple.mockImplementation((model: any) => {
      passedModel.push(model);
      return makeStream([{ type: "thinking_delta", delta: "t", partial: {} }, { type: "done", reason: "stop", message: {} }]);
    });
    await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, () => {});
    const m = passedModel[0];
    expect(m).toBeDefined();
    expect(Array.isArray(m.input)).toBe(true);
    expect(m.input).toContain("text");
    expect(m.cost).toBeDefined();
    expect(typeof m.contextWindow).toBe("number");
    // fish 2026-08-06: maxTokens must NOT exist for OpenAI-compatible APIs —
    // a self-imposed output cap collides with gateway thinking budgets (kimi
    // mid-tier 400 regression).
    expect(m.maxTokens).toBeUndefined();
    expect(m.baseUrl).toBeDefined();
    expect(m.api).toBeDefined();
    expect(m.provider).toBeDefined();
    expect(typeof m.reasoning).toBe("boolean");
  });

  it("L2/L3 streamSimple calls carry NO maxTokens option", async () => {
    mockFetch.mockResolvedValue(okFetch());
    const optsSeen: any[] = [];
    mockStreamSimple.mockImplementation((_model: any, _ctx: any, opts: any) => {
      optsSeen.push(opts);
      return makeStream([{ type: "thinking_delta", delta: "t", partial: {} }, { type: "done", reason: "stop", message: {} }]);
    });
    await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high" }, () => {});
    expect(optsSeen.length).toBeGreaterThan(0);
    for (const opts of optsSeen) {
      expect(opts.maxTokens).toBeUndefined();
    }
  });

  it("buildModel keeps Anthropic maxTokens=36864 (API-required; thinking budget + margin)", async () => {
    mockFetch.mockResolvedValue(okFetch());
    const passedModel: any[] = [];
    mockStreamSimple.mockImplementation((model: any) => {
      passedModel.push(model);
      return makeStream([{ type: "thinking_delta", delta: "t", partial: {} }, { type: "done", reason: "stop", message: {} }]);
    });
    await runPiDiagnostics({ ...FAKE_CRED, thinking_effort: "high", proto_type: "anthropic" }, () => {});
    const m = passedModel[0];
    expect(m.maxTokens).toBe(36_864);
  });
});
