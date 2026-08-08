import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  getCredentialByIdMock: vi.fn(),
  getDefaultCredentialMock: vi.fn(),
}));
const { getCredentialByIdMock, getDefaultCredentialMock } = mocks;
vi.mock("../../src/features/settings/storage.js", () => ({
  getCredentialById: mocks.getCredentialByIdMock,
  getDefaultCredential: mocks.getDefaultCredentialMock,
}));

import { isDynamicEnabled, readPrepareResult, resolvePrepareModel, type PrepareResult } from "../../src/features/workers/prepare-worker.js";

describe("prepare-worker helpers", () => {
  it("isDynamicEnabled reads the source_meta.dynamic_enabled switch, default false", () => {
    expect(isDynamicEnabled({ source_meta: {} } as any)).toBe(false);
    expect(isDynamicEnabled({ source_meta: { dynamic_enabled: true } } as any)).toBe(true);
    expect(isDynamicEnabled({ source_meta: { dynamic_enabled: "true" } } as any)).toBe(true);
    expect(isDynamicEnabled({ source_meta: { dynamic_enabled: false } } as any)).toBe(false);
    expect(isDynamicEnabled({ source_meta: null } as any)).toBe(false);
  });

  it("resolvePrepareModel uses unified buildModelsJson ($ENV_VAR key, no plaintext)", async () => {
    getCredentialByIdMock.mockResolvedValue({ id: "c1", proto_type: "openai-completions", model_id: "glm-4-plus", api_key: "sk-REAL", base_url: "https://api.example.com/v1/", thinking_effort: "off", context_window_tokens: 128000, advanced_config: null });
    const { modelsJson, modelString, apiKeyEnv } = await resolvePrepareModel({ credential_id: "c1" } as any);
    const parsed = JSON.parse(modelsJson);
    const provider = parsed.providers.platform;
    // Key is $ENV_VAR template (no plaintext)
    expect(provider.apiKey).toBe("$VULNHUNTER_LLM_API_KEY");
    expect(JSON.stringify(parsed)).not.toContain("sk-REAL");
    // API key rides the env channel
    expect(apiKeyEnv.VULNHUNTER_LLM_API_KEY).toBe("sk-REAL");
    // openai-completions gets supportsDeveloperRole=false
    expect(provider.models[0].compat?.supportsDeveloperRole).toBe(false);
    expect(provider.api).toBe("openai-completions");
    expect(modelString).toBe("platform/glm-4-plus");
  });

  it("resolvePrepareModel maps anthropic proto to anthropic-messages api", async () => {
    getDefaultCredentialMock.mockResolvedValue({ id: "c2", proto_type: "anthropic", model_id: "claude-4", api_key: "sk-REAL", base_url: "https://api.anthropic.com", thinking_effort: "off", context_window_tokens: 128000, advanced_config: null });
    const { modelsJson, modelString } = await resolvePrepareModel({ credential_id: null } as any);
    const parsed = JSON.parse(modelsJson).providers.platform;
    expect(parsed.api).toBe("anthropic-messages");
    expect(parsed.models[0].id).toBe("claude-4");
    expect(modelString).toBe("platform/claude-4");
    expect(getDefaultCredentialMock).toHaveBeenCalled();
  });

  it("resolvePrepareModel throws when no credential/model is available", async () => {
    getCredentialByIdMock.mockResolvedValue(null);
    getDefaultCredentialMock.mockResolvedValue(null);
    await expect(resolvePrepareModel({ credential_id: null } as any)).rejects.toThrow();
  });

  it("readPrepareResult parses a valid three-field result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-result-"));
    try {
      const good: PrepareResult = { project_complete: true, sandbox_type: "base-linux", reason: "complete" };
      writeFileSync(join(dir, "prepare-result.json"), JSON.stringify(good));
      await expect(readPrepareResult(dir)).resolves.toEqual(good);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPrepareResult accepts fragment_collection reason (fish 2026-08-07)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prepare-result-"));
    try {
      const result = { project_complete: false, sandbox_type: null, reason: "fragment_collection" };
      writeFileSync(join(dir, "prepare-result.json"), JSON.stringify(result));
      await expect(readPrepareResult(dir)).resolves.toEqual(result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPrepareResult fails closed on missing / malformed / wrong-shape results", () => {
    const missing = mkdtempSync(join(tmpdir(), "prepare-result-"));
    const malformed = mkdtempSync(join(tmpdir(), "prepare-result-"));
    const wrongShape = mkdtempSync(join(tmpdir(), "prepare-result-"));
    const badReason = mkdtempSync(join(tmpdir(), "prepare-result-"));
    try {
      writeFileSync(join(malformed, "prepare-result.json"), "{");
      writeFileSync(join(wrongShape, "prepare-result.json"), JSON.stringify({ project_complete: "yes", sandbox_type: null, reason: "complete" }));
      writeFileSync(join(badReason, "prepare-result.json"), JSON.stringify({ project_complete: true, sandbox_type: null, reason: "bogus" }));
      return Promise.all([
        expect(readPrepareResult(missing)).rejects.toThrow(),
        expect(readPrepareResult(malformed)).rejects.toThrow(),
        expect(readPrepareResult(wrongShape)).rejects.toThrow(),
        expect(readPrepareResult(badReason)).rejects.toThrow(),
      ]);
    } finally {
      for (const d of [missing, malformed, wrongShape, badReason]) rmSync(d, { recursive: true, force: true });
    }
  });
});
