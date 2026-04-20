import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import { parseCert, verifyCert } from "../../src/features/license/verify.js";
import type { LicenseBasic, LicenseCert } from "../../src/features/license/types.js";

// Generate a test RSA keypair
let publicKeyPem: string;
let privateKeyPem: string;

function signCert(basic: LicenseBasic, privateKey: string): string {
  const payload = JSON.stringify(basic);
  const signer = createSign("RSA-SHA256");
  signer.update(payload, "utf-8");
  return signer.sign(privateKey, "base64");
}

function makeCert(basic: LicenseBasic, sig: string): LicenseCert {
  return { Basic: basic, Ver: "1", Sig: sig };
}

const validBasic: LicenseBasic = {
  type: "time",
  machine_code: "test-install-uuid",
  software: "vulnhunt",
  version: "1.0",
  expire_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  subject: "Test Customer",
  issuer: "Clouditera",
  auth_at: Math.floor(Date.now() / 1000),
  biz: '{"enabled":true}',
};

beforeAll(() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  publicKeyPem = publicKey;
  privateKeyPem = privateKey;
  // Inject public key for tests
  process.env.VULNHUNT_LICENSE_PUBLIC_KEY = publicKeyPem;
});

describe("parseCert", () => {
  it("parses valid cert JSON", () => {
    const sig = signCert(validBasic, privateKeyPem);
    const cert = makeCert(validBasic, sig);
    const parsed = parseCert(JSON.stringify(cert));
    expect(parsed).not.toBeNull();
    expect(parsed?.Basic.machine_code).toBe("test-install-uuid");
  });

  it("returns null for invalid JSON", () => {
    expect(parseCert("not json")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    expect(parseCert(JSON.stringify({ Basic: {}, Ver: "1" }))).toBeNull(); // no Sig
  });
});

describe("verifyCert", () => {
  it("accepts valid signature", () => {
    const sig = signCert(validBasic, privateKeyPem);
    const cert = makeCert(validBasic, sig);
    expect(verifyCert(cert)).toBe(true);
  });

  it("rejects tampered Basic (wrong machine_code)", () => {
    const sig = signCert(validBasic, privateKeyPem);
    const tampered = makeCert({ ...validBasic, machine_code: "hacker-uuid" }, sig);
    expect(verifyCert(tampered)).toBe(false);
  });

  it("rejects invalid base64 signature", () => {
    const cert = makeCert(validBasic, "notvalidbase64!!!");
    expect(verifyCert(cert)).toBe(false);
  });

  it("rejects empty signature", () => {
    const cert = makeCert(validBasic, "");
    expect(verifyCert(cert)).toBe(false);
  });
});
