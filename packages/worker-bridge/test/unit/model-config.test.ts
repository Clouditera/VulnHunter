import { describe, expect, it } from "vitest";
import { piApiForProtocol } from "../../src/model-config.js";

describe("piApiForProtocol", () => {
  it.each([
    ["openai", "openai-completions"],
    ["openai-completions", "openai-completions"],
    ["openai-responses", "openai-responses"],
    ["anthropic", "anthropic-messages"],
    ["anthropic-messages", "anthropic-messages"],
  ])("maps %s credentials to Pi API %s", (protocol, expected) => {
    expect(piApiForProtocol(protocol)).toBe(expected);
  });

  it("rejects unsupported protocols", () => {
    expect(piApiForProtocol("unknown")).toBeUndefined();
  });
});
