import { logger } from "../../infra/logger.js";
import * as storage from "./storage.js";
import { verifyCert, parseCert, LicenseVerifierUnconfiguredError } from "./verify.js";
import type { LicenseState } from "./types.js";

let installationId: string = "";

export function init(dataDir: string): void {
  installationId = storage.getOrCreateInstallationId(dataDir);
  logger.info({ installationId }, "License service initialized");
}

export function getInstallationId(): string {
  return installationId;
}

export async function getCurrentState(): Promise<LicenseState> {
  // Recompute from DB (no long-lived in-memory cache to avoid stale state on cert change)
  const license = await storage.getActiveLicense();

  if (!license) {
    return { status: "not_activated", machineCode: installationId };
  }

  const now = new Date();

  // Time rollback defense: if last_seen_at is in the future (> now+5min), suspicious
  const lastSeen = license.last_seen_at;
  if (lastSeen > new Date(now.getTime() + 5 * 60 * 1000)) {
    logger.warn({ lastSeen, now }, "Time rollback detected — treating license as expired");
    return { status: "expired", machineCode: installationId };
  }

  const cert = parseCert(license.cert_raw);
  if (!cert) {
    return { status: "invalid", machineCode: installationId };
  }

  try {
    if (!verifyCert(cert)) {
      return { status: "invalid", machineCode: installationId };
    }
  } catch (err) {
    if (err instanceof LicenseVerifierUnconfiguredError) {
      return { status: "invalid", machineCode: installationId };
    }
    throw err;
  }

  if (license.machine_code !== installationId || cert.Basic.machine_code !== installationId) {
    logger.warn({ stored: license.machine_code, certMachine: cert.Basic.machine_code, local: installationId }, "Stored license machine_code mismatch");
    return { status: "invalid", machineCode: installationId };
  }

  if (license.expires_at < now) {
    return {
      status: "expired",
      expiresAt: license.expires_at,
      daysRemaining: 0,
      machineCode: installationId,
    };
  }

  const daysRemaining = Math.ceil(
    (license.expires_at.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

  return {
    status: "active",
    expiresAt: license.expires_at,
    daysRemaining,
    machineCode: installationId,
  };
}

export async function activate(certRaw: string): Promise<{ ok: boolean; error?: string }> {
  const cert = parseCert(certRaw);
  if (!cert) {
    return { ok: false, error: "invalid_format" };
  }

  // Verify RSA signature
  try {
    if (!verifyCert(cert)) {
      return { ok: false, error: "invalid_signature" };
    }
  } catch (err) {
    if (err instanceof LicenseVerifierUnconfiguredError) {
      return { ok: false, error: "license_verifier_unconfigured" };
    }
    throw err;
  }

  // Verify machine_code matches this installation
  if (cert.Basic.machine_code !== installationId) {
    logger.warn(
      { certMachine: cert.Basic.machine_code, local: installationId },
      "License machine_code mismatch",
    );
    return { ok: false, error: "machine_code_mismatch" };
  }

  // Check not already expired
  const expiresAt = new Date(cert.Basic.expire_at * 1000);
  if (expiresAt < new Date()) {
    return { ok: false, error: "already_expired" };
  }

  await storage.saveLicense({
    certRaw,
    machineCode: installationId,
    expiresAt,
  });

  logger.info({ expiresAt, subject: cert.Basic.subject }, "License activated");
  // cache will be recomputed on next getCurrentState() call
  return { ok: true };
}

/** Called hourly to update last_seen */
export async function tick(): Promise<void> {
  await storage.updateLastSeen();
  const state = await getCurrentState();
  logger.debug({ status: state.status, daysRemaining: state.daysRemaining }, "License tick");
}
