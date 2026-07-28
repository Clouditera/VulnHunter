import { Hono } from "hono";
import * as storage from "./credit-codes-storage.js";

export const creditCodesRouter = new Hono();

// POST /api/admin/credit-codes/import
creditCodesRouter.post("/import", async (c) => {
  const body = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  const text = body.text ?? "";
  let parsed: ReturnType<typeof storage.parseCreditCodeImport>;
  try {
    parsed = storage.parseCreditCodeImport(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "import_too_large") {
      return c.json({ error: { code: "ERR_VALIDATION", message: "import text exceeds 256KB" } }, 400);
    }
    if (msg === "import_too_many_lines") {
      return c.json({ error: { code: "ERR_VALIDATION", message: "import exceeds 5000 lines" } }, 400);
    }
    throw err;
  }

  const result = await storage.importCreditCodes(parsed.codes);
  return c.json({
    ok: true,
    inserted: result.inserted,
    // batch-internal dups + DB ON CONFLICT skips
    skipped_duplicates: parsed.skipped_duplicates + result.skipped_duplicates,
    invalid: parsed.invalid,
    invalid_samples: parsed.invalid_samples,
  });
});

// GET /api/admin/credit-codes
creditCodesRouter.get("/", async (c) => {
  const statusRaw = c.req.query("status");
  const status =
    statusRaw === "available" || statusRaw === "assigned" ? statusRaw : undefined;
  const page = Number(c.req.query("page") ?? 1);
  const pageSize = Number(c.req.query("page_size") ?? 20);
  if (!Number.isInteger(page) || page < 1) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "page must be a positive integer" } }, 400);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "page_size must be a positive integer" } }, 400);
  }

  const { items, total, counts } = await storage.listCreditCodes({
    status,
    page,
    pageSize,
  });

  return c.json({
    items: items.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      assigned_user_email: row.assigned_user_email ?? null,
      assigned_at: row.assigned_at,
      created_at: row.created_at,
    })),
    page,
    page_size: Math.min(Math.max(pageSize, 1), 100),
    total,
    counts,
  });
});

// DELETE /api/admin/credit-codes/:id
creditCodesRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const result = await storage.deleteCreditCode(id);
  if (result === "not_found") {
    return c.json({ error: { code: "ERR_NOT_FOUND" } }, 404);
  }
  if (result === "assigned") {
    return c.json({ error: { code: "ERR_CREDIT_CODE_ASSIGNED" } }, 409);
  }
  return c.json({ ok: true });
});
