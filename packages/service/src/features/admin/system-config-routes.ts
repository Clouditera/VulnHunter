import { Hono } from "hono";
import { getSystemConfig, updateSystemConfig } from "../settings/storage.js";
import { getSmtpPublic, saveSmtp, sendMail, type SmtpEncryption } from "../settings/smtp.js";

export const systemConfigRouter = new Hono();

// GET /api/admin/system-config
systemConfigRouter.get("/", async (c) => {
  const config = await getSystemConfig();
  return c.json({ config });
});

// PATCH /api/admin/system-config
systemConfigRouter.patch("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  // youngflow_max_parallel is deprecated (task-level agent_max_parallel); ignore if sent
  if ("youngflow_max_parallel" in body) {
    delete body.youngflow_max_parallel;
  }
  try {
    await updateSystemConfig(body);
  } catch (err) {
    return c.json(
      { error: { code: "ERR_BAD_REQUEST", detail: err instanceof Error ? err.message : "invalid system config" } },
      400,
    );
  }
  return c.json({ ok: true });
});

export const smtpAdminRouter = new Hono();

// GET /api/admin/smtp
smtpAdminRouter.get("/", async (c) => {
  const smtp = await getSmtpPublic();
  return c.json({
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    from_address: smtp.from_address,
    encryption: smtp.encryption,
    configured: smtp.configured,
    password_configured: smtp.password_configured,
  });
});

// PUT /api/admin/smtp
smtpAdminRouter.put("/", async (c) => {
  const body = await c.req.json<{
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    from_address?: string;
    encryption?: SmtpEncryption;
  }>();
  const host = (body.host ?? "").trim();
  const encryption = body.encryption ?? "starttls";
  if (!(["none", "ssl", "starttls"] as const).includes(encryption)) {
    return c.json({ error: { code: "ERR_VALIDATION", message: "invalid encryption" } }, 400);
  }
  try {
    const smtp = await saveSmtp({
      host,
      port: Number(body.port ?? 587),
      username: body.username ?? "",
      password: body.password,
      from_address: (body.from_address ?? "").trim(),
      encryption,
    });
    return c.json({ ok: true, smtp });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "master_key_unavailable") {
      return c.json(
        { error: { code: "ERR_MASTER_KEY", message: "Master key unavailable; cannot encrypt SMTP password" } },
        503,
      );
    }
    throw err;
  }
});

// POST /api/admin/smtp/test
smtpAdminRouter.post("/test", async (c) => {
  const body = await c.req.json<{ to?: string }>();
  const to = (body.to ?? "").trim();
  if (!to) return c.json({ error: { code: "ERR_VALIDATION", message: "to required" } }, 400);
  const pub = await getSmtpPublic();
  if (!pub.configured) {
    return c.json(
      {
        ok: false,
        error: { code: "smtp_not_configured", message: "平台未配置邮件服务，请联系管理员" },
      },
      501,
    );
  }
  const result = await sendMail({
    to,
    subject: "VulnHunter SMTP 测试邮件",
    text: "这是一封来自 VulnHunter 的测试邮件。若您收到此邮件，说明 SMTP 配置正常。",
  });
  if (!result.ok) {
    return c.json({ ok: false, error: { code: "smtp_send_failed", message: result.error } }, 502);
  }
  return c.json({ ok: true });
});
