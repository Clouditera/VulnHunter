import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const skills: Row[] = [];
const reports: Row[] = [];

function matchSql(strings: TemplateStringsArray): string {
  return strings.join("?");
}

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () =>
    Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = matchSql(strings);
        if (sql.includes("DELETE FROM report_skills")) {
          const [id, owner] = values;
          const idx = skills.findIndex((s) => s.id === id && s.owner_user_id === owner);
          if (idx < 0) return [];
          const [removed] = skills.splice(idx, 1);
          return [removed];
        }
        if (sql.includes("INSERT INTO report_skills")) {
          const row = {
            id: "skill-new",
            tenant_id: values[0],
            name: values[1],
            description: values[2],
            minio_key: values[3],
            size_bytes: values[4],
            attachment_count: values[5],
            uploaded_by: values[6],
            owner_user_id: values[7],
            created_at: new Date(),
          };
          skills.push(row);
          return [row];
        }
        if (sql.includes("FROM report_skills") && sql.includes("ORDER BY")) {
          const owner = values[0];
          return skills.filter((s) => s.owner_user_id === owner);
        }
        if (sql.includes("FROM report_skills") && sql.includes("id =") && sql.includes("owner_user_id =")) {
          const [id, owner] = values;
          return skills.filter((s) => s.id === id && s.owner_user_id === owner);
        }
        if (sql.includes("FROM report_skills") && sql.includes("id =")) {
          const id = values[0];
          return skills.filter((s) => s.id === id);
        }
        if (sql.includes("INSERT INTO user_reports")) {
          const row = {
            id: "report-1",
            tenant_id: values[0],
            task_id: values[1],
            skill_id: values[2],
            created_by: values[3],
            started_at: values[4],
            status: "generating",
          };
          reports.push(row);
          return [row];
        }
        return [];
      },
      { json: (v: unknown) => v },
    ),
}));

const storage = await import("../../src/features/reports/storage.js");

describe("report skills user-level storage", () => {
  beforeEach(() => {
    skills.length = 0;
    reports.length = 0;
    skills.push(
      {
        id: "mine",
        owner_user_id: "user-a",
        name: "Mine",
        minio_key: "k1",
      },
      {
        id: "theirs",
        owner_user_id: "user-b",
        name: "Theirs",
        minio_key: "k2",
      },
      {
        id: "legacy",
        owner_user_id: null,
        name: "Legacy global",
        minio_key: "k3",
      },
    );
  });

  it("listSkills only returns own rows (hides legacy NULL)", async () => {
    const mine = await storage.listSkills("user-a");
    expect(mine.map((s) => s.id)).toEqual(["mine"]);
  });

  it("getOwnedSkill rejects others and legacy", async () => {
    await expect(storage.getOwnedSkill("mine", "user-a")).resolves.toMatchObject({ id: "mine" });
    await expect(storage.getOwnedSkill("theirs", "user-a")).resolves.toBeNull();
    await expect(storage.getOwnedSkill("legacy", "user-a")).resolves.toBeNull();
  });

  it("deleteOwnedSkill only deletes own", async () => {
    await expect(storage.deleteOwnedSkill("theirs", "user-a")).resolves.toBeNull();
    await expect(storage.deleteOwnedSkill("legacy", "user-a")).resolves.toBeNull();
    await expect(storage.deleteOwnedSkill("mine", "user-a")).resolves.toMatchObject({ id: "mine" });
    expect(skills.find((s) => s.id === "mine")).toBeUndefined();
  });

  it("createReport accepts null skill_id (builtin template)", async () => {
    const report = await storage.createReport({
      taskId: "task-1",
      skillId: null,
      createdBy: "user-a",
    });
    expect(report.skill_id).toBeNull();
  });

  it("createSkill stamps owner_user_id", async () => {
    const skill = await storage.createSkill({
      name: "new",
      minioKey: "k4",
      sizeBytes: 10,
      uploadedBy: "user-a",
      ownerUserId: "user-a",
    });
    expect(skill.owner_user_id).toBe("user-a");
  });
});
