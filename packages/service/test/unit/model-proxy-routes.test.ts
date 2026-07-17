import { beforeEach, describe, expect, it, vi } from "vitest";

const getTaskByIdMock = vi.fn();
const getCredentialByIdMock = vi.fn();
const getDefaultCredentialMock = vi.fn();
const fetchMock = vi.fn();

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: getTaskByIdMock,
}));
vi.mock("../../src/features/settings/storage.js", () => ({
  getCredentialById: getCredentialByIdMock,
  getDefaultCredential: getDefaultCredentialMock,
}));
vi.stubGlobal("fetch", fetchMock);

const { modelProxyInternalRouter } = await import("../../src/features/model-proxy/routes.js");

const PREPARING_TASK = { id: "task-1", state: "preparing", credential_id: "cred-1" };
const CRED = {
  id: "cred-1",
  proto_type: "openai-completions",
  base_url: "https://api.upstream.example/v1/",
  model_id: "real-model-7",
  api_key: "sk-REAL-SECRET-KEY",
};

function req(path: string, init?: RequestInit, token?: string) {
  return modelProxyInternalRouter.request(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

describe("modelProxyInternalRouter auth (shared taskBearerAuth)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a missing Authorization header", async () => {
    const res = await req("/v1/chat/completions", { method: "POST" });
    expect(res.status).toBe(401);
    expect(getTaskByIdMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown task id", async () => {
    getTaskByIdMock.mockResolvedValue(null);
    const res = await req("/v1/chat/completions", { method: "POST" }, "nope");
    expect(res.status).toBe(401);
  });

  it("rejects a task not in preparing state", async () => {
    getTaskByIdMock.mockResolvedValue({ ...PREPARING_TASK, state: "running" });
    const res = await req("/v1/chat/completions", { method: "POST" }, "task-1");
    expect(res.status).toBe(401);
  });
});

describe("modelProxyInternalRouter forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTaskByIdMock.mockResolvedValue(PREPARING_TASK);
    getCredentialByIdMock.mockResolvedValue(CRED);
  });

  it("forwards path+body to the provider baseUrl and replaces the auth header with the real key", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const res = await req("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "real-model-7", messages: [] }),
    }, "task-1");
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // base_url trailing slash normalized; path appended; query preserved.
    expect(url).toBe("https://api.upstream.example/v1/chat/completions");
    const headers = init.headers as Headers;
    // Real key injected as Bearer (openai proto). Task id is NOT sent upstream.
    expect(headers.get("authorization")).toBe("Bearer sk-REAL-SECRET-KEY");
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("does not leak the task id to the provider (auth header replaced, not appended)", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await req("/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "task-1");
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).not.toContain("task-1");
  });

  it("uses x-api-key for anthropic proto_type", async () => {
    getCredentialByIdMock.mockResolvedValue({ ...CRED, proto_type: "anthropic" });
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await req("/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "task-1");
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("x-api-key")).toBe("sk-REAL-SECRET-KEY");
    expect(headers.get("authorization")).toBeNull();
  });

  it("returns 502 with a fixed code and no credential detail when the credential is unavailable", async () => {
    getCredentialByIdMock.mockResolvedValue(null);
    getDefaultCredentialMock.mockResolvedValue(null);
    const res = await req("/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "task-1");
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("ERR_MODEL_CREDENTIAL_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("sk-REAL-SECRET-KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through an upstream non-2xx verbatim (pi handles retry/error)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "rate limited" }), { status: 429, headers: { "content-type": "application/json" } }));
    const res = await req("/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "task-1");
    expect(res.status).toBe(429);
  });
});
