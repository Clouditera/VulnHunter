import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("migration 033 feedback + chat indexes", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../src/infra/db/migrations/033_feedback_and_chat_search.sql"),
    "utf8",
  );

  it("creates user_feedback and chat indexes", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_feedback/);
    expect(sql).toMatch(/satisfaction INT NOT NULL CHECK/);
    expect(sql).toMatch(/idx_chat_sessions_user_updated/);
    expect(sql).toMatch(/idx_chat_messages_session_seq/);
  });
});
