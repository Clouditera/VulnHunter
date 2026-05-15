import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../../src/mcp/context.js";

const putObjectMock = vi.fn();
const sqlCalls: string[] = [];
const sqlValues: unknown[][] = [];

vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({
    dataDir: "/tmp/vh-chat-artifact-test",
    minio: { bucket: "vulnhunt" },
  })),
}));
vi.mock("../../src/infra/minio/client.js", () => ({
  getMinio: vi.fn(() => ({
    putObject: putObjectMock,
    getObject: vi.fn(async () => Readable.from(["hello"])),
  })),
}));
vi.mock("../../src/infra/db/client.js", () => ({
  getDb: vi.fn(() => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push(strings.join("?"));
    sqlValues.push(values);
    return [];
  }),
}));

const ctx: McpContext = {
  actorType: "chat",
  token: "sess-1",
  sessionId: "sess-1",
  userId: "user-1",
  tenantId: "tenant-1",
  role: "user",
};

describe("presentArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    sqlValues.length = 0;
  });

  it("persists content artifacts to MinIO and chat_artifacts", async () => {
    const { presentArtifact } = await import("../../src/mcp/tools/action-tools.js");

    const result = await presentArtifact({
      title: "High Findings",
      filename: "high-findings.md",
      content: "# High\nhello",
      mime_type: "text/markdown",
    }, ctx);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.type).toBe("chat_artifact");
    expect(payload.title).toBe("High Findings");
    expect(payload.filename).toBe("high-findings.md");
    expect(payload.mime_type).toBe("text/markdown");
    expect(payload.preview).toContain("# High");
    expect(payload.download_url).toContain(`/api/chat/sessions/${ctx.sessionId}/artifacts/`);

    expect(putObjectMock).toHaveBeenCalledWith(
      "vulnhunt",
      expect.stringMatching(/^chat-artifacts\/sess-1\/presented\/.+\/high-findings\.md$/),
      Buffer.from("# High\nhello"),
    );
    expect(sqlCalls[0]).toContain("INSERT INTO chat_artifacts");
    expect(sqlCalls[0]).toContain("'presented'");
    expect(sqlValues[0]).toEqual(expect.arrayContaining([
      "tenant-1",
      "sess-1",
      "user-1",
      "High Findings",
      "high-findings.md",
      "text/markdown",
      12,
    ]));
  });

  it("rejects source_path traversal before reading or writing", async () => {
    const { presentArtifact } = await import("../../src/mcp/tools/action-tools.js");

    const result = await presentArtifact({
      title: "Secret",
      filename: "secret.txt",
      source_path: "/workspace/../secret.txt",
    }, ctx);

    expect(result.content[0].text).toContain("source_path must be within /workspace");
    expect(putObjectMock).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it("requires chat context", async () => {
    const { presentArtifact } = await import("../../src/mcp/tools/action-tools.js");

    const result = await presentArtifact({
      title: "Nope",
      filename: "nope.txt",
      content: "x",
    }, { ...ctx, actorType: "report", sessionId: undefined });

    expect(result.content[0].text).toContain("only available in Chat sessions");
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});
