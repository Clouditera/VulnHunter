import { Hono } from "hono";
import { queryContextFromUser } from "../../infra/query-context.js";
import * as storage from "../feedback/storage.js";

export const adminFeedbackRouter = new Hono();

// GET /api/admin/feedback
adminFeedbackRouter.get("/", async (c) => {
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
