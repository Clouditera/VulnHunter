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

const getTaskByIdMock = vi.fn();
const listWikiPageNamesMock = vi.fn();
const readWikiPageContentMock = vi.fn();
const readArtifactMock = vi.fn();

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: (...a: any[]) => getTaskByIdMock(...a),
}));
vi.mock("../../src/infra/config.js", () => ({
  loadConfig: vi.fn(() => ({ minio: { bucket: "vulnagent" }, dataDir: "/tmp" })),
}));
vi.mock("../../src/features/wiki/routes.js", () => ({
  listWikiPageNames: (...a: any[]) => listWikiPageNamesMock(...a),
  readWikiPageContent: (...a: any[]) => readWikiPageContentMock(...a),
  readArtifact: (...a: any[]) => readArtifactMock(...a),
}));

const { readWiki } = await import("../../src/mcp/tools/query-tools.js");

function flatten(res: any): string {
  return (res?.content ?? []).map((c: any) => c.text ?? "").join("\n");
}

describe("readWiki MCP tool", () => {
  beforeEach(() => {
    getTaskByIdMock.mockReset();
    listWikiPageNamesMock.mockReset();
    readWikiPageContentMock.mockReset();
    readArtifactMock.mockReset();
  });

  it("returns task-not-found when task missing", async () => {
    getTaskByIdMock.mockResolvedValue(null);
    const res = await readWiki({ task_id: "t1" }, ctx);
    expect(flatten(res)).toContain("Task not found");
  });

  it("reads index.md by default when no page given", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "completed" });
    listWikiPageNamesMock.mockResolvedValue(["index.md", "overview.md"]);
    readWikiPageContentMock.mockResolvedValue("# Index\nhello");
    const res = await readWiki({ task_id: "t1" }, ctx);
    expect(readWikiPageContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1" }),
      expect.anything(),
      "index.md",
      false,
    );
    const txt = flatten(res);
    expect(txt).toContain("index.md");
    expect(txt).toContain("hello");
    expect(txt).toContain("overview.md"); // listing shown
  });

  it("reads requested page when valid", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "completed" });
    listWikiPageNamesMock.mockResolvedValue(["index.md", "overview.md"]);
    readWikiPageContentMock.mockResolvedValue("# Overview\nbody");
    const res = await readWiki({ task_id: "t1", page: "overview.md" }, ctx);
    expect(readWikiPageContentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "overview.md",
      false,
    );
    expect(flatten(res)).toContain("body");
  });

  it("falls back to index when requested page is unknown (not arbitrary path)", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "completed" });
    listWikiPageNamesMock.mockResolvedValue(["index.md"]);
    readWikiPageContentMock.mockResolvedValue("# Index");
    await readWiki({ task_id: "t1", page: "../../scans/secret.yaml" }, ctx);
    // Unknown page → falls back to index.md, never passes the traversal string.
    expect(readWikiPageContentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "index.md",
      false,
    );
  });

  it("falls back to profiler.yaml when no wiki pages exist", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "completed" });
    listWikiPageNamesMock.mockResolvedValue([]);
    readArtifactMock.mockResolvedValueOnce("project: openvpn");
    const res = await readWiki({ task_id: "t1" }, ctx);
    expect(flatten(res)).toContain("Project Profile");
    expect(flatten(res)).toContain("openvpn");
  });

  it("reports no data when neither wiki nor profiler exist", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "completed" });
    listWikiPageNamesMock.mockResolvedValue([]);
    readArtifactMock.mockResolvedValue(null);
    const res = await readWiki({ task_id: "t1" }, ctx);
    expect(flatten(res)).toContain("No wiki data");
  });
});
