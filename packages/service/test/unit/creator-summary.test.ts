import { describe, expect, it } from "vitest";
import { attachCreatorSummaries, uniqueCreatorIds } from "../../src/features/auth/creator-summary.js";

describe("creator summary enrichment", () => {
  const users = [
    { id: "user-1", display_name: "Alice", email: "alice@example.com" },
    { id: "user-2", display_name: "Bob", email: "bob@example.com" },
  ];

  it("attaches creator summaries for admin rows", () => {
    const rows = [{ id: "task-1", created_by: "user-1" }];

    expect(attachCreatorSummaries("admin", rows, "created_by", users)).toEqual([
      {
        id: "task-1",
        created_by: "user-1",
        creator: { id: "user-1", display_name: "Alice", email: "alice@example.com" },
      },
    ]);
  });

  it("does not expose creator summaries for non-admin rows", () => {
    const rows = [{ id: "task-1", created_by: "user-1" }];

    expect(attachCreatorSummaries("member", rows, "created_by", users)).toEqual(rows);
  });

  it("returns Unknown for missing users and de-dupes lookup ids", () => {
    const rows = [
      { id: "task-1", created_by: "user-missing" },
      { id: "task-2", created_by: "user-missing" },
      { id: "task-3", created_by: null },
    ];

    expect(uniqueCreatorIds(rows, "created_by")).toEqual(["user-missing"]);
    expect(attachCreatorSummaries("admin", rows, "created_by", [])).toEqual([
      { id: "task-1", created_by: "user-missing", creator: { id: "user-missing", display_name: "Unknown", email: "" } },
      { id: "task-2", created_by: "user-missing", creator: { id: "user-missing", display_name: "Unknown", email: "" } },
      { id: "task-3", created_by: null },
    ]);
  });
});
