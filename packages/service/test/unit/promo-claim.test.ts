import { beforeEach, describe, expect, it, vi } from "vitest";

type CodeRow = {
  id: string;
  code: string;
  status: "available" | "assigned";
  assigned_user_id: string | null;
  created_at: Date;
};

const codes: CodeRow[] = [];
let promoEnabled: unknown = true;
let throwUnique = false;
let myCodeRead = 0;
/** After N my-code reads, auto-bind user-a → CR-RACE (simulates concurrent assign). */
let bindAfterReads = 0;

vi.mock("../../src/infra/db/client.js", () => ({
  getDb: () =>
    Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("SELECT config FROM system_config")) {
          return [{ config: { cloudrouter_promo_enabled: promoEnabled } }];
        }
        if (sql.includes("FROM credit_codes") && sql.includes("assigned_user_id =") && sql.includes("SELECT code")) {
          myCodeRead += 1;
          if (bindAfterReads > 0 && myCodeRead >= bindAfterReads) {
            const race = codes.find((c) => c.code === "CR-RACE");
            if (race) race.assigned_user_id = values[0] as string;
          }
          const userId = values[0];
          const hit = codes.find((c) => c.assigned_user_id === userId);
          return hit ? [{ code: hit.code }] : [];
        }
        if (sql.includes("EXISTS") && sql.includes("status = ")) {
          return [{ ok: codes.some((c) => c.status === "available") }];
        }
        if (sql.includes("UPDATE credit_codes") && sql.includes("FOR UPDATE SKIP LOCKED")) {
          if (throwUnique) {
            const err = Object.assign(new Error("unique"), { code: "23505" });
            throw err;
          }
          const userId = values[0] as string;
          const idx = codes.findIndex((c) => c.status === "available");
          if (idx < 0) return [];
          const row = codes[idx]!;
          row.status = "assigned";
          row.assigned_user_id = userId;
          return [{ code: row.code }];
        }
        return [];
      },
      { json: (v: unknown) => v },
    ),
}));

const storage = await import("../../src/features/promo/storage.js");

describe("promo storage claim state machine", () => {
  beforeEach(() => {
    codes.length = 0;
    promoEnabled = true;
    throwUnique = false;
    myCodeRead = 0;
    bindAfterReads = 0;
    codes.push(
      { id: "1", code: "CR-AAA", status: "available", assigned_user_id: null, created_at: new Date(1) },
      { id: "2", code: "CR-BBB", status: "available", assigned_user_id: null, created_at: new Date(2) },
    );
  });

  it("isCloudrouterPromoEnabled: missing/true → true; false → false", async () => {
    promoEnabled = undefined;
    await expect(storage.isCloudrouterPromoEnabled()).resolves.toBe(true);
    promoEnabled = true;
    await expect(storage.isCloudrouterPromoEnabled()).resolves.toBe(true);
    promoEnabled = false;
    await expect(storage.isCloudrouterPromoEnabled()).resolves.toBe(false);
  });

  it("claim assigns first available; second claim is already_claimed same code", async () => {
    const first = await storage.claimCreditCode("user-a");
    expect(first).toEqual({ kind: "claimed", code: "CR-AAA", already_claimed: false });
    const second = await storage.claimCreditCode("user-a");
    expect(second).toEqual({ kind: "claimed", code: "CR-AAA", already_claimed: true });
    // inventory consumed once
    expect(codes.filter((c) => c.status === "available")).toHaveLength(1);
  });

  it("two users get different codes", async () => {
    const a = await storage.claimCreditCode("user-a");
    const b = await storage.claimCreditCode("user-b");
    expect(a).toMatchObject({ kind: "claimed", code: "CR-AAA" });
    expect(b).toMatchObject({ kind: "claimed", code: "CR-BBB" });
    expect((a as { code: string }).code).not.toBe((b as { code: string }).code);
  });

  it("pool empty returns pool_empty", async () => {
    codes.length = 0;
    await expect(storage.claimCreditCode("user-a")).resolves.toEqual({ kind: "pool_empty" });
  });

  it("23505 unique race re-reads own code", async () => {
    codes.length = 0;
    codes.push({
      id: "x",
      code: "CR-RACE",
      status: "assigned",
      assigned_user_id: null,
      created_at: new Date(),
    });
    throwUnique = true;
    // 1st getMyCreditCode empty; UPDATE throws; 2nd read binds + returns code
    bindAfterReads = 2;
    const result = await storage.claimCreditCode("user-a");
    expect(result).toEqual({ kind: "claimed", code: "CR-RACE", already_claimed: true });
  });

  it("hasAvailableCreditCode reflects inventory", async () => {
    await expect(storage.hasAvailableCreditCode()).resolves.toBe(true);
    codes.forEach((c) => {
      c.status = "assigned";
      c.assigned_user_id = "u";
    });
    await expect(storage.hasAvailableCreditCode()).resolves.toBe(false);
  });
});
