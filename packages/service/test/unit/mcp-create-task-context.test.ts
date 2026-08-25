import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../../src/mcp/context.js";

const ctx: McpContext = {
  actorType: "chat",
  token: "sess-1",
  sessionId: "sess-1",
  userId: "user-1",
  tenantId: "tenant-1",
  role: "member",
};

const createTaskMock = vi.fn();
const cloneAndUploadMock = vi.fn();
const copyObjectMock = vi.fn();
const getDefaultCredentialMock = vi.fn(async () => ({ id: "cred-1", label: "Default" }));
const getCredentialByIdMock = vi.fn(async (...args: any[]) => ({ id: args.at(-1), label: "Selected" }));
let artifactRows: unknown[] = [];
const sqlCalls: string[] = [];

vi.mock("../../src/features/tasks/storage.js", () => ({
  createTask: createTaskMock,
  updateTaskState: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/settings/storage.js", () => ({
  getDefaultCredential: getDefaultCredentialMock,
  getCredentialById: getCredentialByIdMock,
}));
vi.mock("../../src/features/files/git-clone.js", () => ({
  cloneAndUpload: cloneAndUploadMock,
}));
vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: vi.fn(() => ({ copyObject: copyObjectMock })),
  uploadFile: vi.fn(),
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({ minio: { bucket: "artifact-store" }, edition: "enterprise", sandboxPlane: { baseUrl: "", token: "", timeoutMs: 5000 } })),
}));
// Dynamic provider seam (community removal): the toggle-mapping case runs as
// enterprise — a real provider must answer isConfigured=true.
vi.mock("../../src/features/dynamic/provider.js", () => ({
  getDynamicProvider: () => ({ isConfigured: () => true }),
}));
vi.mock("../../src/features/notifications/index.js", () => ({
  notify: vi.fn(),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../src/infra/db/client.js", () => ({
  getDb: vi.fn(() => {
    const db = async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
      sqlCalls.push(strings.join("?"));
      if (strings.join("?").includes("FROM chat_artifacts")) return artifactRows;
      return [];
    };
    (db as any).json = (value: unknown) => JSON.stringify(value);
    return db;
  }),
}));

describe("createMcpTask context binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    artifactRows = [];
    sqlCalls.length = 0;
    createTaskMock.mockResolvedValue({ id: "task-1", project_name: "example", state: "queued" });
    cloneAndUploadMock.mockResolvedValue(undefined);
    getDefaultCredentialMock.mockResolvedValue({ id: "cred-1", label: "Default" });
    getCredentialByIdMock.mockImplementation(async (...args: any[]) => ({ id: args.at(-1), label: "Selected" }));
  });

  it("does not expose credential_id in create-task schema", async () => {
    const { createTaskSchema } = await import("../../src/mcp/tools.js");

    expect(createTaskSchema).not.toHaveProperty("credential_id");
    expect(createTaskSchema).toHaveProperty("display_name");
  });

  it("creates git tasks with ctx.userId and ctx credential, not fake MCP users", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ git_url: "https://example.com/project.git" }, { ...ctx, credentialId: "cred-session" });

    expect(result.content[0].text).toContain("已创建成功");
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: "user-1",
      sourceType: "git",
      sourceMeta: expect.objectContaining({ git_url: "https://example.com/project.git" }),
      credentialId: "cred-session",
    }));
    expect(getCredentialByIdMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", tenantId: "tenant-1", role: "member" }), "cred-session");
    expect(cloneAndUploadMock).toHaveBeenCalledWith("task-1", "https://example.com/project.git", undefined, "artifact-store");
  });

  it("rejects invalid git urls before creating a task", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ git_url: "/workspace" }, { ...ctx, credentialId: "cred-session" });

    expect(result.content[0].text).toContain("合法的 http(s) Git 仓库地址");
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(cloneAndUploadMock).not.toHaveBeenCalled();
  });

  it("passes audit_focus and converts scan_duration minutes to scan_timeout seconds", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    await createMcpTask(
      { git_url: "https://example.com/project.git", audit_focus: "  focus on auth  ", scan_duration: 30 },
      { ...ctx, credentialId: "cred-session" },
    );

    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceMeta: expect.objectContaining({
        git_url: "https://example.com/project.git",
        audit_focus: "focus on auth",
        scan_timeout: 1800,
      }),
    }));
  });

  it("omits scan params when not provided", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    createTaskMock.mockClear();

    await createMcpTask({ git_url: "https://example.com/project.git" }, { ...ctx, credentialId: "cred-session" });

    const meta = createTaskMock.mock.calls.at(-1)![0].sourceMeta;
    expect(meta.audit_focus).toBeUndefined();
    expect(meta.scan_timeout).toBeUndefined();
  });

  it("falls back to default credential when chat session has no credential", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ git_url: "https://example.com/project.git" }, { ...ctx, credentialId: null });

    expect(result.content[0].text).toContain("已创建成功");
    expect(getDefaultCredentialMock).toHaveBeenCalled();
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "cred-1" }));
  });

  it("does not create chat tasks when no credential is available", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    getDefaultCredentialMock.mockResolvedValueOnce(null);

    const result = await createMcpTask({ git_url: "https://example.com/project.git" }, { ...ctx, credentialId: null });

    expect(result.content[0].text).toContain("当前会话没有可用模型凭证");
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it("creates upload tasks only from artifacts owned by current chat context", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    artifactRows = [{
      id: "artifact-1",
      original_name: "project.zip",
      minio_key: "chat-artifacts/sess-1/project.zip",
      size_bytes: 1234,
      session_id: "sess-1",
      user_id: "user-1",
      tenant_id: "tenant-1",
    }];

    const result = await createMcpTask({ attachment_id: "artifact-1" }, ctx);

    expect(result.content[0].text).toContain("已创建成功");
    expect(sqlCalls.some((s) => s.includes("session_id") && s.includes("user_id") && s.includes("tenant_id"))).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: "user-1",
      projectName: "project",
      sourceType: "upload",
      credentialId: "cred-1",
    }));
    expect(copyObjectMock).toHaveBeenCalledWith("artifact-store", "code-packages/task-1.zip", "/artifact-store/chat-artifacts/sess-1/project.zip");
  });

  it("rejects inaccessible attachment ids", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ attachment_id: "other-artifact" }, ctx);

    expect(result.content[0].text).toContain("not found or not accessible");
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it("maps dynamic toggles + timeout_mode to source_meta identically to the web form", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    const { scanMetaFromValues } = await import("../../src/features/files/routes.js");
    createTaskMock.mockClear();

    await createMcpTask(
      {
        git_url: "https://example.com/project.git",
        audit_focus: "auth",
        scan_duration: 600,
        timeout_mode: "custom",
        enable_dynamic_verify: true,
        enable_dynamic_exploit: true,
      },
      { ...ctx, credentialId: "cred-session" },
    );

    const chatMeta = createTaskMock.mock.calls.at(-1)![0].sourceMeta;
    // The form channel builds meta from the same logical inputs via the same
    // scanMetaFromValues — byte-equivalence is by construction.
    const formMeta = scanMetaFromValues("auth", 600 * 60, undefined, "custom", {
      enableDynamicVerify: true, enableDynamicExploit: true,
    }, undefined, "enterprise");
    for (const [k, v] of Object.entries(formMeta)) {
      expect(chatMeta[k]).toEqual(v);
    }
    expect(chatMeta.enable_poc).toBe(true);
    expect(chatMeta.enable_exp).toBe(true);
    expect(chatMeta.enable_chain).toBe(true);
    expect(chatMeta.dynamic_enabled).toBe(true);
    expect(chatMeta.timeout_mode).toBe("custom");
    expect(chatMeta.scan_timeout).toBe(36000);
  });

  it("auto timeout_mode forces the fixed 72h ceiling and ignores scan_duration", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    createTaskMock.mockClear();

    await createMcpTask(
      { git_url: "https://example.com/project.git", scan_duration: 30, timeout_mode: "auto" },
      { ...ctx, credentialId: "cred-session" },
    );

    const meta = createTaskMock.mock.calls.at(-1)![0].sourceMeta;
    expect(meta.timeout_mode).toBe("auto");
    expect(meta.scan_timeout).toBe(72 * 3600);
  });

  it("rejects enable_dynamic_exploit without enable_dynamic_verify (model must restate)", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    createTaskMock.mockClear();

    const result = await createMcpTask(
      { git_url: "https://example.com/project.git", enable_dynamic_exploit: true },
      { ...ctx, credentialId: "cred-session" },
    );

    expect(result.content[0].text).toContain("Error");
    expect(result.content[0].text).toContain("动态验证");
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it("legacy calls (no new params) produce identical source_meta to before", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    createTaskMock.mockClear();

    await createMcpTask({ git_url: "https://example.com/project.git" }, { ...ctx, credentialId: "cred-session" });

    const meta = createTaskMock.mock.calls.at(-1)![0].sourceMeta;
    expect(meta.enable_poc).toBeUndefined();
    expect(meta.enable_exp).toBeUndefined();
    expect(meta.enable_chain).toBeUndefined();
    expect(meta.dynamic_enabled).toBeUndefined();
    expect(meta.timeout_mode).toBeUndefined();
  });
});
