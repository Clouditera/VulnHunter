import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseModelCredential } from "../../src/features/settings/model-diagnostics.js";

const input = { protoType: "openai-completions", baseUrl: "http://model.local/v1", modelId: "demo", apiKey: "secret" };

afterEach(() => vi.restoreAllMocks());

function mockFetch(handler: (url: string, body: any) => { status?: number; text: string; contentType?: string }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const result = handler(url, JSON.parse(String(init.body ?? "{}")));
    return new Response(result.text, { status: result.status ?? 200, headers: { "content-type": result.contentType ?? "application/json" } });
  }));
}

describe("diagnoseModelCredential", () => {
  it("classifies auth failures without leaking api key", async () => {
    mockFetch(() => ({ status: 401, text: "invalid api key secret" }));
    const result = await diagnoseModelCredential(input);
    expect(result.ok).toBe(false);
    expect(result.checks[1].category).toBe("auth");
    expect(JSON.stringify(result)).not.toContain("Bearer secret");
  });

  it("warns when basic and stream pass but tool calls are missing", async () => {
    mockFetch((_url, body) => {
      if (body.stream) return { text: "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n", contentType: "text/event-stream" };
      return { text: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    });
    const result = await diagnoseModelCredential(input);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === "tool")?.status).toBe("warn");
    expect(result.summary).toContain("部分能力");
  });

  it("reports stream format failures", async () => {
    mockFetch((_url, body) => body.stream ? { text: "{}", contentType: "application/json" } : { text: "{\"ok\":true}" });
    const result = await diagnoseModelCredential(input);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "stream")?.category).toBe("stream");
  });
});
