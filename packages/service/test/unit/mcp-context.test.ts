import { beforeEach, describe, expect, it, vi } from "vitest";

let chatRows: unknown[] = [];
let userRows: unknown[] = [];

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: vi.fn(() => async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FROM chat_sessions")) return chatRows;
    if (sql.includes("FROM users")) return userRows;
    return [];
  }),
}));

describe("resolveMcpContext", () => {
  beforeEach(() => {
    chatRows = [];
    userRows = [];
  });

  it("binds chat session credential id into MCP context", async () => {
    const { resolveMcpContext } = await import("../../src/mcp/context.js");
    chatRows = [{ id: "sess-1", user_id: "user-1", tenant_id: "tenant-1", credential_id: "cred-1" }];
    userRows = [{ role: "member" }];

    const ctx = await resolveMcpContext("sess-1");

    expect(ctx).toEqual(expect.objectContaining({
      actorType: "chat",
      sessionId: "sess-1",
      userId: "user-1",
      tenantId: "tenant-1",
      credentialId: "cred-1",
    }));
  });
});
