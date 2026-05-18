import { logger } from "../../infra/logger.js";
import * as storage from "./storage.js";
import { verifyCert, parseCert, LicenseVerifierUnconfiguredError } from "./verify.js";
import { getVersionInfo } from "../../infra/version.js";
import { checkLicenseVersion } from "./version-compat.js";
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
  const license = await storage.getActiveLicense();

  if (!license) {
    return { status: "not_activated", machineCode: installationId };
  }

  const now = new Date();

  const lastSeen = license.last_seen_at;
  if (lastSeen > new Date(now.getTime() + 5 * 60 * 1000)) {
    logger.warn({ lastSeen, now }, "Time rollback detected — treating license as expired");
    return { status: "expired", machineCode: installationId };
  }

  const cert = parseCert(license.cert_raw);
  if (!cert) {
    return { status: "invalid", machineCode: installationId, invalidReason: "invalid_format" };
  }

  if (cert.Basic.software !== "vulnhunt") {
    return { status: "invalid", machineCode: installationId, licensedVersion: cert.Basic.version, invalidReason: "wrong_software" };
  }

  const versionCheck = checkLicenseVersion(cert.Basic.version, getVersionInfo().version);
  if (!versionCheck.ok) {
    return { status: "invalid", machineCode: installationId, licensedVersion: cert.Basic.version, invalidReason: versionCheck.reason };
  }

  try {
    if (!verifyCert(cert)) {
      return { status: "invalid", machineCode: installationId, licensedVersion: cert.Basic.version, invalidReason: "invalid_signature" };
    }
  } catch (err) {
    if (err instanceof LicenseVerifierUnconfiguredError) {
      return { status: "invalid", machineCode: installationId, licensedVersion: cert.Basic.version, invalidReason: "license_verifier_unconfigured" };
    }
    throw err;
  }

  if (license.machine_code !== installationId || cert.Basic.machine_code !== installationId) {
    logger.warn({ stored: license.machine_code, certMachine: cert.Basic.machine_code, local: installationId }, "Stored license machine_code mismatch");
    return { status: "invalid", machineCode: installationId, licensedVersion: cert.Basic.version, invalidReason: "machine_code_mismatch" };
  }

  if (license.expires_at < now) {
    return {
      status: "expired",
      expiresAt: license.expires_at,
      daysRemaining: 0,
      machineCode: installationId,
      licensedVersion: cert.Basic.version,
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
    licensedVersion: cert.Basic.version,
  };
}

export async function activate(certRaw: string): Promise<{ ok: boolean; error?: string }> {
  const cert = parseCert(certRaw);
  if (!cert) {
    return { ok: false, error: "invalid_format" };
  }

  if (cert.Basic.software !== "vulnhunt") {
    return { ok: false, error: "wrong_software" };
  }

  const versionCheck = checkLicenseVersion(cert.Basic.version, getVersionInfo().version);
  if (!versionCheck.ok) {
    return { ok: false, error: versionCheck.reason };
  }

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

  if (cert.Basic.machine_code !== installationId) {
    logger.warn(
      { certMachine: cert.Basic.machine_code, local: installationId },
      "License machine_code mismatch",
    );
    return { ok: false, error: "machine_code_mismatch" };
  }

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
  return { ok: true };
}

export async function tick(): Promise<void> {
  await storage.updateLastSeen();
  const state = await getCurrentState();
  logger.debug({ status: state.status, daysRemaining: state.daysRemaining }, "License tick");
}
