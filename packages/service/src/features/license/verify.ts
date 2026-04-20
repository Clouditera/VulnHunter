/**
 * License certificate verification — RSA-2048 + SHA256 + PKCS1v15
 * Signature covers JSON.stringify(cert.Basic) (stable key order assumed from issuer).
 */

import { createVerify } from "node:crypto";
import type { LicenseCert } from "./types.js";

/**
 * The issuer's RSA-2048 public key (PEM).
 * In production, embed the real public key here or load from env.
 * Env var VULNHUNT_LICENSE_PUBLIC_KEY overrides this.
 * Read at call time (not module-load time) to support test injection.
 */
function getPublicKey(): string {
  return process.env.VULNHUNT_LICENSE_PUBLIC_KEY ?? "";
}

export function verifyCert(cert: LicenseCert): boolean {
  const pubKey = getPublicKey();
  if (!pubKey) {
    // Dev mode: no public key configured — accept any cert (DO NOT use in production)
    if (process.env.NODE_ENV === "production") {
      throw new Error("VULNHUNT_LICENSE_PUBLIC_KEY must be set in production");
    }
    return true; // dev/test fallback
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
