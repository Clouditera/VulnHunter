import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const m037 = readFileSync(
  new URL("../../src/infra/db/migrations/037_report_skills_owner.sql", import.meta.url),
  "utf8",
);
const m038 = readFileSync(
  new URL("../../src/infra/db/migrations/038_task_agent_max_parallel.sql", import.meta.url),
  "utf8",
);
const m039 = readFileSync(
  new URL("../../src/infra/db/migrations/039_report_skill_nullable.sql", import.meta.url),
  "utf8",
);

describe("migration 037 report_skills owner", () => {
  it("adds owner_user_id + index", () => {
    expect(m037).toMatch(/ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(m037).toMatch(/idx_report_skills_owner/);
  });
});

describe("migration 038 task agent_max_parallel", () => {
  it("adds column with default 3 and backfills in-flight tasks", () => {
    expect(m038).toMatch(/ADD COLUMN IF NOT EXISTS agent_max_parallel INTEGER NOT NULL DEFAULT 3/);
    expect(m038).toMatch(/youngflow_max_parallel/);
    expect(m038).toMatch(/queued.*preparing.*running|state IN \('queued', 'preparing', 'running'\)/);
  });
});

describe("migration 039 report skill nullable", () => {
  it("makes skill_id nullable with ON DELETE SET NULL", () => {
    expect(m039).toMatch(/DROP CONSTRAINT IF EXISTS user_reports_skill_id_fkey/);
    expect(m039).toMatch(/ALTER COLUMN skill_id DROP NOT NULL/);
    expect(m039).toMatch(/ON DELETE SET NULL/);
  });
});
