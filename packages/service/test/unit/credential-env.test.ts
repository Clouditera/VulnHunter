import { describe, expect, it } from "vitest";
import { credentialToWorkerEnv } from "../../src/features/settings/credential-env.js";
import type { DecryptedLlmCredential } from "../../src/features/settings/storage.js";

describe("credentialToWorkerEnv", () => {
  it("serializes context window tokens", () => {
    const cred: DecryptedLlmCredential = {
      id: "cred-1",
      provider: "openai",
      proto_type: "openai-completions",
      base_url: "https://llm.example/v1/",
      model_id: "example-model",
      thinking_effort: "medium",
      label: "Example",
      is_default: true,
      key_fingerprint: "fp",
      context_window_tokens: 256000,
      api_key: "sk-test",
    };

    expect(credentialToWorkerEnv(cred)).toMatchObject({
      LLM_CONTEXT_WINDOW_TOKENS: "256000",
      LLM_BASE_URL: "https://llm.example/v1",
    });
  });
});
