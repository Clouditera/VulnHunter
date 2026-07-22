import nodemailer from "nodemailer";
import { getSystemConfig, updateSystemConfig } from "./storage.js";
import { getVaultOptional } from "./storage.js";
import { logger } from "../../infra/logger.js";

export type SmtpEncryption = "none" | "ssl" | "starttls";

export interface SmtpPublicConfig {
  host: string;
  port: number;
  username: string;
  from_address: string;
  encryption: SmtpEncryption;
  configured: boolean;
  password_configured: boolean;
}

interface SmtpStored {
  host?: string;
  port?: number;
  username?: string;
  password_enc?: { ciphertext: string; iv: string; tag: string } | null;
  from_address?: string;
  encryption?: SmtpEncryption;
}

function readStored(): SmtpStored {
  // filled via getSystemConfig in async helpers
  return {};
}

export async function getSmtpPublic(): Promise<SmtpPublicConfig> {
  const cfg = await getSystemConfig();
  const smtp = ((cfg.smtp as SmtpStored | undefined) ?? {}) as SmtpStored;
  const host = (smtp.host ?? "").trim();
  return {
    host,
    port: Number(smtp.port ?? 587) || 587,
    username: smtp.username ?? "",
    from_address: smtp.from_address ?? "",
    encryption: (smtp.encryption ?? "starttls") as SmtpEncryption,
    configured: host.length > 0,
    password_configured: !!smtp.password_enc?.ciphertext,
  };
}

export async function isSmtpConfigured(): Promise<boolean> {
  const pub = await getSmtpPublic();
  return pub.configured;
}

export async function saveSmtp(input: {
  host: string;
  port: number;
  username?: string;
  password?: string;
  from_address: string;
  encryption: SmtpEncryption;
}): Promise<SmtpPublicConfig> {
  const cfg = await getSystemConfig();
  const prev = ((cfg.smtp as SmtpStored | undefined) ?? {}) as SmtpStored;
  let password_enc = prev.password_enc ?? null;
  if (input.password != null && input.password !== "") {
    const vault = getVaultOptional();
    if (!vault) throw new Error("master_key_unavailable");
    const enc = vault.encrypt(input.password);
    password_enc = {
      ciphertext: enc.ciphertext.toString("base64"),
      iv: enc.iv.toString("base64"),
      tag: enc.tag.toString("base64"),
    };
  }
  const next: SmtpStored = {
    host: input.host.trim(),
    port: Number(input.port) || 587,
    username: input.username ?? "",
    password_enc,
    from_address: input.from_address.trim(),
    encryption: input.encryption ?? "starttls",
  };
  await updateSystemConfig({ smtp: next });
  return getSmtpPublic();
}

async function resolvePassword(smtp: SmtpStored): Promise<string | null> {
  if (!smtp.password_enc?.ciphertext) return null;
  const vault = getVaultOptional();
  if (!vault) return null;
  try {
    return vault.decrypt({
      ciphertext: Buffer.from(smtp.password_enc.ciphertext, "base64"),
      iv: Buffer.from(smtp.password_enc.iv, "base64"),
      tag: Buffer.from(smtp.password_enc.tag, "base64"),
    });
  } catch (err) {
    logger.warn({ err }, "SMTP password decrypt failed");
    return null;
  }
}

export async function sendMail(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = await getSystemConfig();
  const smtp = ((cfg.smtp as SmtpStored | undefined) ?? {}) as SmtpStored;
  const host = (smtp.host ?? "").trim();
  if (!host) return { ok: false, error: "smtp_not_configured" };

  const password = await resolvePassword(smtp);
  const port = Number(smtp.port ?? 587) || 587;
  const encryption = (smtp.encryption ?? "starttls") as SmtpEncryption;
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: encryption === "ssl",
    requireTLS: encryption === "starttls",
    auth: smtp.username
      ? { user: smtp.username, pass: password ?? "" }
      : undefined,
  });

  try {
    await transporter.sendMail({
      from: smtp.from_address || smtp.username || "noreply@vulnhunter.local",
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, to: params.to }, "SMTP send failed");
    return { ok: false, error: message };
  }
}

export async function sendVerificationEmail(params: {
  to: string;
  code: string;
  purpose: "register" | "reset";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const action = params.purpose === "register" ? "注册" : "重置密码";
  const subject = `VulnHunter ${action}验证码`;
  const text = `您的验证码是 ${params.code}，5 分钟内有效。如非本人操作请忽略。`;
  return sendMail({ to: params.to, subject, text });
}

// silence unused
void readStored;
