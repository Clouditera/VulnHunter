import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryContext } from "../../src/infra/query-context.js";

let dbCalled = false;

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: vi.fn(() => async () => {
    dbCalled = true;
    return [];
  }),
}));

const { getSessionForContext } = await import("../../src/features/chat/storage.js");

const ctx: QueryContext = { tenantId: "t1", userId: "u1", role: "member" } as unknown as QueryContext;

describe("getSessionForContext — UUID guard", () => {
  beforeEach(() => { dbCalled = false; });

  it("returns null for the literal 'draft' id without querying the DB", async () => {
    const res = await getSessionForContext("draft", ctx);
    expect(res).toBeNull();
    expect(dbCalled).toBe(false);
  });

  it("returns null for other non-UUID ids without querying the DB", async () => {
    expect(await getSessionForContext("not-a-uuid", ctx)).toBeNull();
    expect(await getSessionForContext("", ctx)).toBeNull();
    expect(dbCalled).toBe(false);
  });

  it("queries the DB for a well-formed UUID", async () => {
    await getSessionForContext("11aede56-1e41-44db-b6b7-a2a03d914847", ctx);
    expect(dbCalled).toBe(true);
  });
});
