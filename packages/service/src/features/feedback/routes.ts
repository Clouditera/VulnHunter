import { Hono } from "hono";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { licenseGuard } from "../../middleware/license-guard.js";
import { queryContextFromUser } from "../../infra/query-context.js";
import * as storage from "./storage.js";

export const feedbackRouter = new Hono();
feedbackRouter.use("*", licenseGuard);
feedbackRouter.use("*", requireAuth);

// POST /api/feedback — any authenticated user
feedbackRouter.post("/", async (c) => {
  const user = c.get("user");
  const ctx = queryContextFromUser(user);
  const body = await c.req.json<{
    satisfaction?: number;
    content?: string;
    contact_email?: string | null;
  }>();

  const satisfaction = Number(body.satisfaction);
  if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 10) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "satisfaction must be integer 1–10" } }, 400);
  }
  const content = (body.content ?? "").trim();
  if (!content || content.length > 5000) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "content required (max 5000 chars)" } }, 400);
  }
  const contact = body.contact_email == null || body.contact_email === ""
    ? null
    : String(body.contact_email).trim().slice(0, 320);

  const row = await storage.createFeedback({
    userId: user.userId,
    satisfaction,
    content,
    contactEmail: contact,
    tenantId: ctx.tenantId,
  });
  return c.json({
    ok: true,
    feedback: {
      id: row.id,
      satisfaction: row.satisfaction,
      content: row.content,
      contact_email: row.contact_email,
      created_at: row.created_at,
    },
  }, 201);
});

// GET /api/feedback — admin list
feedbackRouter.get("/", requireAdmin, async (c) => {
  const ctx = queryContextFromUser(c.get("user"));
  const limit = Number(c.req.query("limit") ?? 50);
  const offset = Number(c.req.query("offset") ?? 0);
  const { items, total } = await storage.listFeedback({
    limit,
    offset,
    tenantId: ctx.tenantId,
  });
  return c.json({
    total,
    feedback: items.map((f) => ({
      id: f.id,
      satisfaction: f.satisfaction,
      content: f.content,
      contact_email: f.contact_email,
      created_at: f.created_at,
      user: f.user_id
        ? { id: f.user_id, email: f.user_email ?? null, display_name: f.user_display_name ?? null }
        : null,
    })),
  });
});
