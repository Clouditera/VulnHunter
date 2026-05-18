import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import type { LicenseBasic, LicenseCert } from "../../src/features/license/types.js";

const storageState = vi.hoisted(() => ({
  activeLicense: null as null | {
    id: string;
    cert_raw: string;
    machine_code: string;
    expires_at: Date;
    activated_at: Date;
    last_seen_at: Date;
  },
  saved: null as null | { certRaw: string; machineCode: string; expiresAt: Date },
}));

vi.mock("../../src/features/license/storage.js", () => ({
  getOrCreateInstallationId: () => "local-machine",
  getActiveLicense: async () => storageState.activeLicense,
  saveLicense: async (params: { certRaw: string; machineCode: string; expiresAt: Date }) => {
    storageState.saved = params;
  },
  updateLastSeen: async () => {},
}));

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function makeCert(overrides: Partial<LicenseBasic> = {}): string {
  const basic: LicenseBasic = {
    type: "time",
    machine_code: "local-machine",
    software: "vulnhunt",
    version: "1.0",
    expire_at: Math.floor(Date.now() / 1000) + 3600,
    subject: "Test Customer",
    issuer: "Clouditera",
    auth_at: Math.floor(Date.now() / 1000),
    biz: '{"enabled":true}',
    ...overrides,
  };
  const signer = createSign("RSA-SHA256");
  signer.update(JSON.stringify(basic), "utf-8");
  const cert: LicenseCert = { Basic: basic, Ver: "1", Sig: signer.sign(privateKey, "base64") };
  return JSON.stringify(cert);
}

beforeEach(async () => {
  vi.resetModules();
  process.env.VULNHUNT_VERSION = "1.0.1";
  storageState.activeLicense = null;
  storageState.saved = null;
  process.env.VULNHUNT_LICENSE_PUBLIC_KEY = publicKey;
  delete process.env.VULNHUNT_LICENSE_PUBLIC_KEY_FILE;
  delete process.env.NODE_ENV;
  const service = await import("../../src/features/license/service.js");
  service.init("/tmp/vh-license-test");
});

describe("license service", () => {
  it("reports not activated when no license exists", async () => {
    const service = await import("../../src/features/license/service.js");
    await expect(service.getCurrentState()).resolves.toMatchObject({
      status: "not_activated",
      machineCode: "local-machine",
    });
  });

  it("rejects activation when machine code mismatches", async () => {
    const service = await import("../../src/features/license/service.js");
    await expect(service.activate(makeCert({ machine_code: "other-machine" }))).resolves.toEqual({
      ok: false,
      error: "machine_code_mismatch",
    });
    expect(storageState.saved).toBeNull();
  });

  it("rejects expired certificate activation", async () => {
    const service = await import("../../src/features/license/service.js");
    await expect(service.activate(makeCert({ expire_at: Math.floor(Date.now() / 1000) - 60 }))).resolves.toEqual({
      ok: false,
      error: "already_expired",
    });
  });

  it("rejects activation for an incompatible VulnHunt version", async () => {
    const service = await import("../../src/features/license/service.js");
    await expect(service.activate(makeCert({ version: "1.1" }))).resolves.toEqual({
      ok: false,
      error: "version_mismatch",
    });
  });

  it("rejects activation for a different software product", async () => {
    const service = await import("../../src/features/license/service.js");
    await expect(service.activate(makeCert({ software: "other-product" }))).resolves.toEqual({
      ok: false,
      error: "wrong_software",
    });
  });

  it("activates a valid VulnHunt certificate", async () => {
    const service = await import("../../src/features/license/service.js");
    await expect(service.activate(makeCert())).resolves.toEqual({ ok: true });
    expect(storageState.saved).toMatchObject({ machineCode: "local-machine" });
  });

  it("returns invalid when stored license version mismatches current version", async () => {
    const certRaw = makeCert({ version: "1.1" });
    storageState.activeLicense = {
      id: "lic-1",
      cert_raw: certRaw,
      machine_code: "local-machine",
      expires_at: new Date(Date.now() + 3600_000),
      activated_at: new Date(),
      last_seen_at: new Date(),
    };
    const service = await import("../../src/features/license/service.js");
    await expect(service.getCurrentState()).resolves.toMatchObject({ status: "invalid", invalidReason: "version_mismatch" });
  });

  it("returns invalid when stored license software is not VulnHunt", async () => {
    const certRaw = makeCert({ software: "other-product" });
    storageState.activeLicense = {
      id: "lic-1",
      cert_raw: certRaw,
      machine_code: "local-machine",
      expires_at: new Date(Date.now() + 3600_000),
      activated_at: new Date(),
      last_seen_at: new Date(),
    };
    const service = await import("../../src/features/license/service.js");
    await expect(service.getCurrentState()).resolves.toMatchObject({ status: "invalid" });
  });

  it("returns invalid when stored license machine mismatches current installation", async () => {
    const certRaw = makeCert({ machine_code: "other-machine" });
    storageState.activeLicense = {
      id: "lic-1",
      cert_raw: certRaw,
      machine_code: "other-machine",
      expires_at: new Date(Date.now() + 3600_000),
      activated_at: new Date(),
      last_seen_at: new Date(),
    };
    const service = await import("../../src/features/license/service.js");
    await expect(service.getCurrentState()).resolves.toMatchObject({ status: "invalid" });
  });

  it("does not activate arbitrary cert in production when verifier is unconfigured", async () => {
    delete process.env.VULNHUNT_LICENSE_PUBLIC_KEY;
    process.env.NODE_ENV = "production";
    const service = await import("../../src/features/license/service.js");
    await expect(service.activate(makeCert())).resolves.toEqual({
      ok: false,
      error: "license_verifier_unconfigured",
    });
  });
});
