/**
 * License certificate verification — RSA-2048 + SHA256 + PKCS1v15
 * Signature covers JSON.stringify(cert.Basic) (stable key order assumed from issuer).
 */

import { createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { LicenseCert } from "./types.js";

export class LicenseVerifierUnconfiguredError extends Error {
  constructor() {
    super("license_verifier_unconfigured");
    this.name = "LicenseVerifierUnconfiguredError";
  }
}

/**
 * The issuer's RSA-2048 public key (PEM).
 * Env var VULNHUNT_LICENSE_PUBLIC_KEY overrides file config.
 * Env var VULNHUNT_LICENSE_PUBLIC_KEY_FILE loads a PEM from disk.
 * Read at call time to support test injection.
 */
function normalizePublicKey(raw: string): string {
  const key = raw.trim();
  return key.includes("-----BEGIN PUBLIC KEY-----") || key.includes("-----BEGIN RSA PUBLIC KEY-----")
    ? key
    : "";
}

function getPublicKey(): string {
  if (process.env.VULNHUNT_LICENSE_PUBLIC_KEY) return normalizePublicKey(process.env.VULNHUNT_LICENSE_PUBLIC_KEY);
  const file = process.env.VULNHUNT_LICENSE_PUBLIC_KEY_FILE;
  if (!file) return "";
  try {
    return normalizePublicKey(readFileSync(file, "utf-8"));
  } catch {
    return "";
  }
}

export function verifyCert(cert: LicenseCert): boolean {
  const pubKey = getPublicKey();
  if (!pubKey) {
    if (process.env.NODE_ENV === "production") {
      throw new LicenseVerifierUnconfiguredError();
    }
    return true; // dev/test fallback only
  }

  try {
    const payload = JSON.stringify(cert.Basic);
    const sig = Buffer.from(cert.Sig, "base64");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(payload, "utf-8");
    return verifier.verify(pubKey, sig);
  } catch {
    return false;
  }
}

export function parseCert(rawCert: string): LicenseCert | null {
  try {
    const cert = JSON.parse(rawCert) as LicenseCert;
    if (!cert.Basic || !cert.Ver || !cert.Sig) return null;
    const b = cert.Basic;
    if (!b.machine_code || !b.expire_at || !b.software) return null;
    return cert;
  } catch {
    return null;
  }
}
