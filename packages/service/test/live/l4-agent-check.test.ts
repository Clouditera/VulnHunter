import { describe, expect, it } from "vitest";
import { runL4Check } from "../../src/features/settings/l4-agent-check.js";

// These tests use fake API keys to verify the subprocess plumbing and
// error handling. A real credential would exercise the full agent circuit.
// Timeouts are expected with invalid endpoints.

describe("L4 agent check", () => {
  it("returns structured fail result with invalid credentials (no crash)", async () => {
    const result = await runL4Check({
      baseUrl: "https://httpbin.org/status/401",
      apiKey: "sk-fake-invalid-key-for-testing",
      modelId: "test-model",
      protoType: "openai-completions",
    });

    expect(result.status).toBe("fail");
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.detail).toBeTruthy();
    expect(typeof result.detail).toBe("string");
  }, 70_000);
});
