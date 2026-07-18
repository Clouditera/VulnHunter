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

  it("rejects a malformed (non-UUID) task id with 401, not a DB 500", async () => {
    getTaskByIdMock.mockRejectedValue(new Error("invalid input syntax for type uuid"));
    const res = await req("/chat/completions", { method: "POST" }, "not-a-uuid");
    expect(res.status).toBe(401);
  });

  it("rejects a task in a non-allowed state (queued/completed), accepts preparing and running", async () => {
    // queued and completed are NOT in {preparing, running} → 401
    for (const state of ["queued", "completed", "cancelled", "paused"]) {
      getTaskByIdMock.mockResolvedValue({ ...PREPARING_TASK, state });
      const res = await req("/v1/chat/completions", { method: "POST" }, "task-1");
      expect(res.status).toBe(401);
    }
    // preparing and running ARE allowed (scan workers run in `running`).
    getCredentialByIdMock.mockResolvedValue(CRED);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    for (const state of ["preparing", "running"]) {
      getTaskByIdMock.mockResolvedValue({ ...PREPARING_TASK, state });
      const res = await req("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "task-1");
      expect(res.status).toBe(200);
    }
  });

  it("accepts a task id carried in the x-api-key header (anthropic-messages path)", async () => {
    getTaskByIdMock.mockResolvedValue(PREPARING_TASK);
    getCredentialByIdMock.mockResolvedValue(CRED);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const res = await modelProxyInternalRouter.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "task-1" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(getTaskByIdMock).toHaveBeenCalledWith("task-1");
  });

  it("rejects an unknown task id in x-api-key and prefers Authorization over x-api-key", async () => {
    // unknown x-api-key → 401
    getTaskByIdMock.mockResolvedValue(null);
    let res = await modelProxyInternalRouter.request("/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": "nope" }, body: "{}",
    });
    expect(res.status).toBe(401);
    // Bearer present + different x-api-key → Bearer wins (x-api-key ignored as task-id)
    getTaskByIdMock.mockResolvedValue(PREPARING_TASK);
    getCredentialByIdMock.mockResolvedValue(CRED);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    res = await modelProxyInternalRouter.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer task-1", "x-api-key": "nope" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(getTaskByIdMock).toHaveBeenCalledWith("task-1");
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
