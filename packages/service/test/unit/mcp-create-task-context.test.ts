import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../../src/mcp/context.js";

const ctx: McpContext = {
  actorType: "chat",
  token: "sess-1",
  sessionId: "sess-1",
  userId: "user-1",
  tenantId: "tenant-1",
  role: "user",
};

const createTaskMock = vi.fn();
const cloneAndUploadMock = vi.fn();
const copyObjectMock = vi.fn();
const getDefaultCredentialMock = vi.fn(async () => ({ id: "cred-1", label: "Default" }));
const getCredentialByIdMock = vi.fn(async (id: string) => ({ id, label: "Selected" }));
let artifactRows: unknown[] = [];
const sqlCalls: string[] = [];

vi.mock("../../src/features/tasks/storage.js", () => ({
  createTask: createTaskMock,
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
  loadConfig: vi.fn(() => ({ minio: { bucket: "vulnhunt" } })),
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
    createTaskMock.mockResolvedValue({ id: "task-1", project_name: "demo", state: "queued" });
    cloneAndUploadMock.mockResolvedValue(undefined);
    getDefaultCredentialMock.mockResolvedValue({ id: "cred-1", label: "Default" });
    getCredentialByIdMock.mockImplementation(async (id: string) => ({ id, label: "Selected" }));
  });

  it("does not expose credential_id in create-task schema", async () => {
    const { createTaskSchema } = await import("../../src/mcp/tools.js");

    expect(createTaskSchema).not.toHaveProperty("credential_id");
  });

  it("creates git tasks with ctx.userId and ctx credential, not fake MCP users", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ git_url: "https://example.com/demo.git" }, { ...ctx, credentialId: "cred-session" });

    expect(result.content[0].text).toContain("Task created successfully");
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: "user-1",
      sourceType: "git",
      sourceMeta: expect.objectContaining({ git_url: "https://example.com/demo.git" }),
      credentialId: "cred-session",
    }));
    expect(getCredentialByIdMock).toHaveBeenCalledWith("cred-session");
  });

  it("falls back to default credential when chat session has no credential", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ git_url: "https://example.com/demo.git" }, { ...ctx, credentialId: null });

    expect(result.content[0].text).toContain("Task created successfully");
    expect(getDefaultCredentialMock).toHaveBeenCalled();
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "cred-1" }));
  });

  it("does not create chat tasks when no credential is available", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");
    getDefaultCredentialMock.mockResolvedValueOnce(null);

    const result = await createMcpTask({ git_url: "https://example.com/demo.git" }, { ...ctx, credentialId: null });

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

    expect(result.content[0].text).toContain("Task created from uploaded file");
    expect(sqlCalls.some((s) => s.includes("session_id") && s.includes("user_id") && s.includes("tenant_id"))).toBe(true);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: "user-1",
      projectName: "project",
      sourceType: "upload",
      credentialId: "cred-1",
    }));
    expect(copyObjectMock).toHaveBeenCalledWith("vulnhunt", "code-packages/task-1.zip", "/vulnhunt/chat-artifacts/sess-1/project.zip");
  });

  it("rejects inaccessible attachment ids", async () => {
    const { createMcpTask } = await import("../../src/mcp/tools.js");

    const result = await createMcpTask({ attachment_id: "other-artifact" }, ctx);

    expect(result.content[0].text).toContain("not found or not accessible");
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
