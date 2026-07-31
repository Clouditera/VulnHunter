/**
 * Self-service API token management — settings page only path.
 * Mounted at /api/me (business role). Admin has no entry (forbidAdmin + no UI).
 */
import { Hono } from "hono";
import { licenseGuard, requireAuth } from "../../middleware/index.js";
import {
  API_TOKEN_EXPIRY_DAYS,
  API_TOKEN_LIMIT,
  issueApiToken,
  listApiTokens,
  renameApiToken,
  revokeApiTokenForUser,
} from "./api-token-storage.js";
import type { SessionUser } from "./types.js";

export const meApiTokensRouter = new Hono();

meApiTokensRouter.use("*", licenseGuard, requireAuth);

function errCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/** GET /api/me/api-tokens */
meApiTokensRouter.get("/api-tokens", async (c) => {
  const user = c.get("user") as SessionUser;
  const result = await listApiTokens(user.userId);
  return c.json(result);
});

/** POST /api/me/api-tokens  body: { name, expires_in_days: number|null } */
meApiTokensRouter.post("/api-tokens", async (c) => {
  const user = c.get("user") as SessionUser;
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    expires_in_days?: unknown;
  };
  const name = typeof body.name === "string" ? body.name : "";
  let expiresInDays: number | null = null;
  if (body.expires_in_days === null || body.expires_in_days === undefined) {
    expiresInDays = null;
  } else if (typeof body.expires_in_days === "number") {
    expiresInDays = body.expires_in_days;
    if (!(API_TOKEN_EXPIRY_DAYS as readonly number[]).includes(expiresInDays)) {
      return c.json({ error: { code: "ERR_API_TOKEN_NAME_REQUIRED", detail: "invalid expires_in_days" } }, 400);
    }
  } else {
    return c.json({ error: { code: "ERR_API_TOKEN_NAME_REQUIRED", detail: "invalid expires_in_days" } }, 400);
  }

  try {
    const { token, view } = await issueApiToken(user.userId, name, expiresInDays);
    return c.json({ token: view, plaintext: token, limit: API_TOKEN_LIMIT }, 201);
  } catch (err) {
    const code = errCode(err);
    if (code === "ERR_API_TOKEN_LIMIT") {
      return c.json({ error: { code, used: API_TOKEN_LIMIT, limit: API_TOKEN_LIMIT } }, 403);
    }
    if (code === "ERR_API_TOKEN_NAME_REQUIRED") {
      return c.json({ error: { code } }, 400);
    }
    throw err;
  }
});

/** PATCH /api/me/api-tokens/:id  body: { name } */
meApiTokensRouter.patch("/api-tokens/:id", async (c) => {
  const user = c.get("user") as SessionUser;
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name : "";
  try {
    const token = await renameApiToken(user.userId, id, name);
    return c.json({ token });
  } catch (err) {
    const code = errCode(err);
    if (code === "ERR_API_TOKEN_NOT_FOUND") return c.json({ error: { code } }, 404);
    if (code === "ERR_API_TOKEN_NAME_REQUIRED") return c.json({ error: { code } }, 400);
    throw err;
  }
});

/** DELETE /api/me/api-tokens/:id — revoke */
meApiTokensRouter.delete("/api-tokens/:id", async (c) => {
  const user = c.get("user") as SessionUser;
  const id = c.req.param("id");
  try {
    const token = await revokeApiTokenForUser(user.userId, id);
    return c.json({ token });
  } catch (err) {
    const code = errCode(err);
    if (code === "ERR_API_TOKEN_NOT_FOUND") return c.json({ error: { code } }, 404);
    throw err;
  }
});
