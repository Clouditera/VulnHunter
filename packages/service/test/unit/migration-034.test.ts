import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("migration 034 purge empty chat sessions", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../src/infra/db/migrations/034_purge_empty_chat_sessions.sql"),
    "utf8",
  );

  it("deletes sessions with zero messages", () => {
    expect(sql).toMatch(/DELETE FROM chat_sessions/);
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/chat_messages/);
  });
});
