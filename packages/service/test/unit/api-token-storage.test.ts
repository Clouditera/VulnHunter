import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TokenRow {
  id: string;
  user_id: string;
  tenant_id: string;
  name: string;
  token_hash: string;
  token_prefix: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  status: string;
}
interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  display_name: string;
  status: string;
}

const tokens: TokenRow[] = [];
const users = new Map<string, UserRow>();
let idSeq = 0;

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

vi.mock("../../src/infra/db/client.js", () => ({
  getDb:
    () =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");

      // count non-revoked for limit
      if (sql.includes("SELECT count(*)") && sql.includes("user_api_tokens")) {
        const [userId] = values as [string];
        const n = tokens.filter((t) => t.user_id === userId && t.revoked_at === null).length;
        return [{ n: String(n) }];
      }

      // issueApiToken INSERT ... RETURNING full row
      if (sql.includes("INSERT INTO user_api_tokens")) {
        const [name, tokenHash, tokenPrefix, expiresAt, userId] = values as [
          string,
          string,
          string,
          Date | null,
          string,
        ];
        const user = users.get(userId);
        if (!user) return [];
        const row: TokenRow = {
          id: `tok-${++idSeq}`,
          user_id: user.id,
          tenant_id: user.tenant_id,
          name,
          token_hash: tokenHash,
          token_prefix: tokenPrefix,
          created_at: new Date(),
          expires_at: expiresAt ?? null,
          last_used_at: null,
          revoked_at: null,
          status: "active",
        };
        tokens.push(row);
        return [
          {
            id: row.id,
            name: row.name,
            created_at: row.created_at,
            expires_at: row.expires_at,
            last_used_at: row.last_used_at,
            revoked_at: row.revoked_at,
            status: row.status,
          },
        ];
      }

      // list
      if (
        sql.includes("SELECT id, name, token_prefix, created_at, expires_at, last_used_at, revoked_at") &&
        sql.includes("FROM user_api_tokens") &&
        sql.includes("ORDER BY")
      ) {
        const [userId] = values as [string];
        return tokens
          .filter((t) => t.user_id === userId)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .map((t) => ({
            id: t.id,
            name: t.name,
            token_prefix: t.token_prefix,
            created_at: t.created_at,
            expires_at: t.expires_at,
            last_used_at: t.last_used_at,
            revoked_at: t.revoked_at,
            status: t.status,
          }));
      }

      // rename
      if (sql.includes("SET name =") && sql.includes("user_api_tokens")) {
        const [name, id, userId] = values as [string, string, string];
        const tok = tokens.find((t) => t.id === id && t.user_id === userId);
        if (!tok) return [];
        tok.name = name;
        return [
          {
            id: tok.id,
            name: tok.name,
            token_prefix: tok.token_prefix,
            created_at: tok.created_at,
            expires_at: tok.expires_at,
            last_used_at: tok.last_used_at,
            revoked_at: tok.revoked_at,
            status: tok.status,
          },
        ];
      }

      // resolveApiToken
      if (sql.includes("FROM user_api_tokens t") && sql.includes("JOIN users u")) {
        const [tokenHash] = values as [string];
        const tok = tokens.find((t) => t.token_hash === tokenHash && t.revoked_at === null && t.status === "active");
        if (!tok) return [];
        if (tok.expires_at && tok.expires_at.getTime() <= Date.now()) return [];
        const user = users.get(tok.user_id);
        if (!user || user.status !== "active") return [];
        return [
          {
            token_id: tok.id,
            user_id: user.id,
            tenant_id: user.tenant_id,
            email: user.email,
            role: user.role,
            display_name: user.display_name,
          },
        ];
      }

      // last_used_at bump
      if (sql.includes("SET last_used_at = now()")) {
        const [tokenId] = values as [string];
        const tok = tokens.find((t) => t.id === tokenId);
        if (tok) tok.last_used_at = new Date();
        return [];
      }

      // setApiTokenStatus: guard select
      if (sql.includes("SELECT revoked_at FROM user_api_tokens")) {
        const [id, userId] = values as [string, string];
        const tok = tokens.find((t) => t.id === id && t.user_id === userId);
        return tok ? [{ revoked_at: tok.revoked_at }] : [];
      }

      // setApiTokenStatus: update
      if (sql.includes("SET status =") && sql.includes("user_api_tokens")) {
        const [status, id, userId] = values as [string, string, string];
        const tok = tokens.find((t) => t.id === id && t.user_id === userId);
        if (!tok) return [];
        tok.status = status;
        return [
          {
            id: tok.id,
            name: tok.name,
            token_prefix: tok.token_prefix,
            created_at: tok.created_at,
            expires_at: tok.expires_at,
            last_used_at: tok.last_used_at,
            revoked_at: tok.revoked_at,
            status: tok.status,
          },
        ];
      }

      // deleteApiTokenForUser
      if (sql.includes("DELETE FROM user_api_tokens")) {
        const [id, userId] = values as [string, string];
        const idx = tokens.findIndex((t) => t.id === id && t.user_id === userId);
        if (idx < 0) return [];
        const [gone] = tokens.splice(idx, 1);
        return [{ id: gone.id }];
      }

      // revoke (scoped or unscoped)
      if (sql.includes("SET revoked_at") && sql.includes("user_api_tokens")) {
        if (sql.includes("user_id")) {
          const [id, userId] = values as [string, string];
          const tok = tokens.find((t) => t.id === id && t.user_id === userId);
          if (!tok) return [];
          if (!tok.revoked_at) tok.revoked_at = new Date();
          return [
            {
              id: tok.id,
              name: tok.name,
              created_at: tok.created_at,
              expires_at: tok.expires_at,
              last_used_at: tok.last_used_at,
              revoked_at: tok.revoked_at,
              status: tok.status,
            },
          ];
        }
        const [id] = values as [string];
        const tok = tokens.find((t) => t.id === id && t.revoked_at === null);
        if (tok) tok.revoked_at = new Date();
        return [];
      }

      return [];
    },
}));

const {
  issueApiToken,
  resolveApiToken,
  revokeApiToken,
  revokeApiTokenForUser,
  setApiTokenStatus,
  deleteApiTokenForUser,
  listApiTokens,
  renameApiToken,
  API_TOKEN_LIMIT,
  computeTokenStatus,
} = await import("../../src/features/auth/api-token-storage.js");

const ACTIVE_USER: UserRow = {
  id: "user-1",
  tenant_id: "tenant-1",
  email: "svc@example.com",
  role: "member",
  display_name: "Service Account",
  status: "active",
};

describe("api-token-storage", () => {
  beforeEach(() => {
    tokens.length = 0;
    users.clear();
    users.set(ACTIVE_USER.id, { ...ACTIVE_USER });
    idSeq = 0;
  });

  describe("issueApiToken", () => {
    it("returns a vht_-prefixed plaintext token and stores only its sha256 hash", async () => {
      const { id, token } = await issueApiToken("user-1", "openvuln");
      expect(id).toBeTruthy();
      expect(token).toMatch(/^vht_[A-Za-z0-9_-]+$/);
      const stored = tokens.find((t) => t.id === id);
      expect(stored?.token_hash).toBe(sha256(token));
      expect(stored?.token_hash).not.toBe(token);
    });

    it("stores expires_at when days provided; null when permanent", async () => {
      const a = await issueApiToken("user-1", "t90", 90);
      expect(tokens.find((t) => t.id === a.id)?.expires_at).toBeInstanceOf(Date);
      const b = await issueApiToken("user-1", "tperm", null);
      expect(tokens.find((t) => t.id === b.id)?.expires_at).toBeNull();
    });

    it("enforces per-user non-revoked limit", async () => {
      for (let i = 0; i < API_TOKEN_LIMIT; i++) {
        await issueApiToken("user-1", `t${i}`);
      }
      await expect(issueApiToken("user-1", "overflow")).rejects.toMatchObject({
        code: "ERR_API_TOKEN_LIMIT",
      });
    });

    it("throws when the user does not exist", async () => {
      await expect(issueApiToken("ghost", "x")).rejects.toThrow(/not found/);
    });
  });

  describe("resolveApiToken", () => {
    it("resolves a live token to the owning user's SessionUser projection", async () => {
      const { id, token } = await issueApiToken("user-1", "openvuln");
      const user = await resolveApiToken(token);
      expect(user).toEqual({
        userId: "user-1",
        tenantId: "tenant-1",
        email: "svc@example.com",
        role: "member",
        displayName: "Service Account",
        sessionId: `apitoken:${id}`,
      });
    });

    it("returns null for a revoked token", async () => {
      const { id, token } = await issueApiToken("user-1", "openvuln");
      await revokeApiToken(id);
      expect(await resolveApiToken(token)).toBeNull();
    });

    it("returns null for an expired token", async () => {
      const { id, token } = await issueApiToken("user-1", "old", 30);
      const tok = tokens.find((t) => t.id === id)!;
      tok.expires_at = new Date(Date.now() - 1000);
      expect(await resolveApiToken(token)).toBeNull();
    });

    it("returns null when the owning user is suspended", async () => {
      const { token } = await issueApiToken("user-1", "openvuln");
      const owner = users.get("user-1");
      if (owner) owner.status = "suspended";
      expect(await resolveApiToken(token)).toBeNull();
    });
  });

  describe("list / rename / revoke scoped", () => {
    it("lists tokens with status", async () => {
      await issueApiToken("user-1", "a", 90);
      const { tokens: list, limit, count } = await listApiTokens("user-1");
      expect(limit).toBe(API_TOKEN_LIMIT);
      expect(count).toBe(1);
      expect(list[0]?.name).toBe("a");
      expect(list[0]?.status).toBe("active");
    });

    it("renames a token", async () => {
      const { id } = await issueApiToken("user-1", "old");
      const v = await renameApiToken("user-1", id, "new");
      expect(v.name).toBe("new");
    });

    it("revokes via scoped helper", async () => {
      const { id, token } = await issueApiToken("user-1", "x");
      await revokeApiTokenForUser("user-1", id);
      expect(await resolveApiToken(token)).toBeNull();
    });
  });

  describe("computeTokenStatus", () => {
    it("classifies active / expired / revoked", () => {
      expect(computeTokenStatus({ revoked_at: null, expires_at: null })).toBe("active");
      expect(
        computeTokenStatus({
          revoked_at: null,
          expires_at: new Date(Date.now() - 1000),
        }),
      ).toBe("expired");
      expect(
        computeTokenStatus({
          revoked_at: new Date(),
          expires_at: null,
        }),
      ).toBe("revoked");
    });

    it("classifies disabled (below revoked, above expired)", () => {
      expect(computeTokenStatus({ revoked_at: null, expires_at: null, status: "disabled" })).toBe("disabled");
      // revoked stays terminal even if status column says disabled
      expect(computeTokenStatus({ revoked_at: new Date(), expires_at: null, status: "disabled" })).toBe("revoked");
    });
  });

  describe("setApiTokenStatus", () => {
    it("disabled token fails resolveApiToken; re-enable restores it", async () => {
      const { id, token } = await issueApiToken("user-1", "gate");
      await setApiTokenStatus("user-1", id, "disabled");
      expect(await resolveApiToken(token)).toBeNull();
      const v = await setApiTokenStatus("user-1", id, "active");
      expect(v.status).toBe("active");
      expect((await resolveApiToken(token))?.userId).toBe("user-1");
    });

    it("view reports disabled status", async () => {
      const { id } = await issueApiToken("user-1", "badge");
      const v = await setApiTokenStatus("user-1", id, "disabled");
      expect(v.status).toBe("disabled");
    });

    it("re-enabling a revoked token throws ERR_API_TOKEN_REVOKED", async () => {
      const { id } = await issueApiToken("user-1", "dead");
      await revokeApiTokenForUser("user-1", id);
      await expect(setApiTokenStatus("user-1", id, "active")).rejects.toMatchObject({
        code: "ERR_API_TOKEN_REVOKED",
      });
    });

    it("unknown id throws ERR_API_TOKEN_NOT_FOUND", async () => {
      await expect(setApiTokenStatus("user-1", "nope", "disabled")).rejects.toMatchObject({
        code: "ERR_API_TOKEN_NOT_FOUND",
      });
    });
  });

  describe("deleteApiTokenForUser", () => {
    it("hard-deletes the row; token can never resolve again", async () => {
      const { id, token } = await issueApiToken("user-1", "gone");
      await deleteApiTokenForUser("user-1", id);
      expect(await resolveApiToken(token)).toBeNull();
      const { tokens: list } = await listApiTokens("user-1");
      expect(list.find((t) => t.id === id)).toBeUndefined();
    });

    it("delete frees a slot against the per-user limit (unlike disable)", async () => {
      const { id } = await issueApiToken("user-1", "slot");
      await deleteApiTokenForUser("user-1", id);
      const { count } = await listApiTokens("user-1");
      expect(count).toBe(0);
    });

    it("unknown id throws ERR_API_TOKEN_NOT_FOUND", async () => {
      await expect(deleteApiTokenForUser("user-1", "nope")).rejects.toMatchObject({
        code: "ERR_API_TOKEN_NOT_FOUND",
      });
    });
  });
});
