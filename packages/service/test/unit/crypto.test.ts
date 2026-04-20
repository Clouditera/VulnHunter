import { describe, it, expect } from "vitest";
import { MasterKeyVault } from "../../src/infra/crypto/master-key-vault.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

describe("MasterKeyVault", () => {
  it("encrypts and decrypts roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-test-"));
    const vault = new MasterKeyVault(dir);

    const plaintext = "sk-ant-my-secret-api-key-1234567890";
    const encrypted = vault.encrypt(plaintext);
    const decrypted = vault.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
    expect(encrypted.ciphertext).not.toEqual(Buffer.from(plaintext));
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.tag.length).toBe(16);
  });

  it("different IVs produce different ciphertexts for same plaintext", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-test-"));
    const vault = new MasterKeyVault(dir);

    const enc1 = vault.encrypt("same-text");
    const enc2 = vault.encrypt("same-text");

    expect(enc1.iv).not.toEqual(enc2.iv);
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
  });

  it("wrong tag fails decryption", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-test-"));
    const vault = new MasterKeyVault(dir);

    const enc = vault.encrypt("secret");
    const badTag = Buffer.alloc(16, 0);

    expect(() => vault.decrypt({ ...enc, tag: badTag })).toThrow();
  });

  it("persists and loads key from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vh-test-"));
    const vault1 = new MasterKeyVault(dir);
    const enc = vault1.encrypt("persistent-test");

    // Second vault reads same file
    const vault2 = new MasterKeyVault(dir);
    const dec = vault2.decrypt(enc);
    expect(dec).toBe("persistent-test");
  });
});
