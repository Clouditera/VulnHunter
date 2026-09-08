import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as unknown[],
  sql: "",
  values: [] as unknown[],
}));

vi.mock("../../src/infra/db/client.js", () => ({
  getDb:
    () =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      m.sql = strings.join("?");
      m.values = values;
      return m.rows;
    },
}));

const { isSourceArchiveKeyReferenced } = await import("../../src/features/tasks/storage.js");

beforeEach(() => {
  m.rows = [];
  m.sql = "";
  m.values = [];
});

describe("isSourceArchiveKeyReferenced fail-closed result contract", () => {
  it.each([
    [true, true],
    [false, false],
  ])("returns the one strict boolean result (%s)", async (stored, expected) => {
    m.rows = [{ referenced: stored }];
    await expect(isSourceArchiveKeyReferenced("code-packages/a.zip")).resolves.toBe(expected);
  });

  it.each([
    ["no row", []],
    ["multiple rows", [{ referenced: false }, { referenced: true }]],
    ["string false", [{ referenced: "false" }]],
    ["numeric zero", [{ referenced: 0 }]],
    ["missing field", [{}]],
  ])("throws on an abnormal %s result so callers retain the object", async (_name, rows) => {
    m.rows = rows;
    await expect(isSourceArchiveKeyReferenced("code-packages/a.zip")).rejects.toThrow(
      "Invalid source archive reference query result",
    );
  });

  it("uses one system-wide task/chat query and explicit full JS-trim characters", async () => {
    const key = "code-packages/a.zip";
    m.rows = [{ referenced: true }];
    await isSourceArchiveKeyReferenced(key);

    expect(m.sql).toContain("FROM tasks t");
    expect(m.sql).toContain("FROM chat_artifacts a");
    expect(m.sql).not.toContain("tenant_id =");
    const trimValues = m.values.filter((value) => value !== key);
    expect(trimValues).toHaveLength(3);
    for (const value of trimValues) {
      expect(typeof value).toBe("string");
      expect((value as string).trim()).toBe("");
      expect(value).toContain("\t");
      expect(value).toContain("\n");
      expect(value).toContain("\u00a0");
      expect(value).toContain("\ufeff");
    }
  });
});
