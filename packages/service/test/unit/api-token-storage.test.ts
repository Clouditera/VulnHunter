import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TokenRow {
  id: string;
  user_id: string;
  tenant_id: string;
  name: string;
  token_hash: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
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

      // issueApiToken: INSERT ... SELECT ... FROM users WHERE u.id = ? RETURNING id
      if (sql.includes("INSERT INTO user_api_tokens")) {
        const [name, tokenHash, userId] = values as [string, string, string];
        const user = users.get(userId);
        if (!user) return [];
        const row: TokenRow = {
          id: `tok-${++idSeq}`,
          user_id: user.id,
          tenant_id: user.tenant_id,
          name,
          token_hash: tokenHash,
          last_used_at: null,
          revoked_at: null,
        };
        tokens.push(row);
        return [{ id: row.id }];
      }

      // resolveApiToken: SELECT ... JOIN users ... WHERE token_hash = ? AND revoked_at IS NULL AND status='active'
      if (sql.includes("FROM user_api_tokens t") && sql.includes("JOIN users u")) {
        const [tokenHash] = values as [string];
        const tok = tokens.find((t) => t.token_hash === tokenHash && t.revoked_at === null);
        if (!tok) return [];
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

      // revokeApiToken
      if (sql.includes("SET revoked_at = now()")) {
        const [id] = values as [string];
        const tok = tokens.find((t) => t.id === id && t.revoked_at === null);
        if (tok) tok.revoked_at = new Date();
        return [];
      }

      return [];
    },
}));

const { issueApiToken, resolveApiToken, revokeApiToken } = await import(
  "../../src/features/auth/api-token-storage.js"
);

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
      // Stored row holds hash, never plaintext (criterion 4).
      const stored = tokens.find((t) => t.id === id);
      expect(stored?.token_hash).toBe(sha256(token));
      expect(stored?.token_hash).not.toBe(token);
    });

    it("produces a different token on each issue for the same user (criterion 4)", async () => {
      const a = await issueApiToken("user-1", "t1");
      const b = await issueApiToken("user-1", "t2");
      expect(a.token).not.toBe(b.token);
      expect(a.id).not.toBe(b.id);
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

    it("uses a synthetic apitoken:<id> sessionId that cannot collide with real sessions", async () => {
      const { token } = await issueApiToken("user-1", "openvuln");
      const user = await resolveApiToken(token);
      expect(user?.sessionId.startsWith("apitoken:")).toBe(true);
    });

    it("bumps last_used_at on a hit", async () => {
      const { id, token } = await issueApiToken("user-1", "openvuln");
      await resolveApiToken(token);
      // fire-and-forget update; allow the microtask to flush
      await Promise.resolve();
      expect(tokens.find((t) => t.id === id)?.last_used_at).not.toBeNull();
    });

    it("returns null for a token without the vht_ prefix (fail closed)", async () => {
      expect(await resolveApiToken("nope_abc")).toBeNull();
      expect(await resolveApiToken("")).toBeNull();
    });

    it("returns null for an unknown token hash", async () => {
      expect(await resolveApiToken("vht_unknownrandom")).toBeNull();
    });

    it("returns null for a revoked token", async () => {
      const { id, token } = await issueApiToken("user-1", "openvuln");
      await revokeApiToken(id);
      expect(await resolveApiToken(token)).toBeNull();
    });

    it("returns null when the owning user is not active (suspended)", async () => {
      const { token } = await issueApiToken("user-1", "openvuln");
      const owner = users.get("user-1");
      if (owner) owner.status = "suspended";
      expect(await resolveApiToken(token)).toBeNull();
    });
  });

  describe("revokeApiToken", () => {
    it("sets revoked_at so the token stops resolving", async () => {
      const { id, token } = await issueApiToken("user-1", "openvuln");
      expect(await resolveApiToken(token)).not.toBeNull();
      await revokeApiToken(id);
      expect(tokens.find((t) => t.id === id)?.revoked_at).not.toBeNull();
      expect(await resolveApiToken(token)).toBeNull();
    });
  });
});
