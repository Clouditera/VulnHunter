import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Runtime set-model body is credentialId-only (fish 2026-08-10).
 * Bridge resolves providerKey via startup credProviderMap.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

vi.mock("../../src/features/settings/storage.js", () => ({
  getCredentialById: vi.fn(async () => ({
    id: "cred-b",
    thinking_effort: "medium",
  })),
  getDefaultOrFirstAvailableCredential: vi.fn(),
  listCredentials: vi.fn(),
}));
vi.mock("../../src/features/chat/storage.js", () => ({
  getSession: vi.fn(),
  updateSessionCredential: vi.fn(),
}));
vi.mock("../../src/features/workers/docker-client.js", () => ({
  getDocker: vi.fn(),
  ensureWorkDir: vi.fn(),
  createWorkerContainer: vi.fn(),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({ dataDir: "/tmp", docker: {} })),
}));
vi.mock("../../src/features/events/ws-live-log.js", () => ({
  notify: vi.fn(),
}));

const { ChatSession } = await import("../../src/features/chat/chat-session.js");

describe("ChatSession.setModel body (registered-key path)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      json: async () => ({ ok: true, provider: "va-cred-b12", modelId: "glm-5.1" }),
    });
  });

  it("when ready, POSTs only credentialId (+ thinkingEffort) — no modelsJson/platform key", async () => {
    const session = new ChatSession("11111111-1111-4111-8111-111111111111");
    // Force ready state + bridge URL via private fields
    (session as any).state = "ready";
    (session as any).bridgeUrl = "http://127.0.0.1:9";

    await session.setModel("22222222-2222-4222-8222-222222222222");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:9/chat/set-model");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      credentialId: "22222222-2222-4222-8222-222222222222",
      thinkingEffort: "medium",
    });
    expect(body.modelsJson).toBeUndefined();
    expect(body.providerKey).toBeUndefined();
  });
});
