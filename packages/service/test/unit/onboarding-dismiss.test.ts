import { beforeEach, describe, expect, it, vi } from "vitest";

const users = new Map<string, { onboarding_dismissed_at: Date | null }>();
const updates: string[] = [];

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () =>
    Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("onboarding_dismissed_at = COALESCE")) {
          const userId = values[0] as string;
          updates.push(userId);
          const u = users.get(userId) ?? { onboarding_dismissed_at: null };
          if (u.onboarding_dismissed_at == null) {
            u.onboarding_dismissed_at = new Date("2026-07-28T00:00:00Z");
          }
          users.set(userId, u);
          return [];
        }
        if (sql.includes("FROM users") && sql.includes("id =")) {
          const id = values[0] as string;
          const u = users.get(id);
          if (!u) return [];
          return [{ id, onboarding_dismissed_at: u.onboarding_dismissed_at, email: "a@b.c", display_name: "a", role: "member", must_change_password: false, source: "registered", task_limit: 0 }];
        }
        return [];
      },
      { json: (v: unknown) => v },
    ),
}));

const storage = await import("../../src/features/auth/storage.js");

describe("dismissOnboarding", () => {
  beforeEach(() => {
    users.clear();
    updates.length = 0;
    users.set("u1", { onboarding_dismissed_at: null });
  });

  it("sets timestamp once and is idempotent", async () => {
    await storage.dismissOnboarding("u1");
    const first = users.get("u1")!.onboarding_dismissed_at;
    expect(first).toBeInstanceOf(Date);
    await storage.dismissOnboarding("u1");
    expect(users.get("u1")!.onboarding_dismissed_at).toBe(first);
    expect(updates).toHaveLength(2);
  });
});

describe("ERR_PROMO_DISABLED catalog", () => {
  it("is registered with 403", async () => {
    const { ERROR_CATALOG } = await import("@vulnhunter/shared");
    expect(ERROR_CATALOG.ERR_PROMO_DISABLED.httpStatus).toBe(403);
  });
});
