import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("empty chat session policy in storage", () => {
  const src = readFileSync(
    resolve(__dirname, "../../src/features/chat/storage.ts"),
    "utf8",
  );

  it("defines purge + grace window and filters list/search by EXISTS messages", () => {
    expect(src).toMatch(/purgeStaleEmptySessions/);
    expect(src).toMatch(/EMPTY_SESSION_GRACE_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(src).toMatch(/EXISTS \(SELECT 1 FROM chat_messages/);
    // listSessionsPage and search both call purge
    expect(src.match(/purgeStaleEmptySessions/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
