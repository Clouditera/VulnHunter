import { describe, it, expect } from "vitest";
import { MasterKeyVault, CredentialDecryptError } from "../../src/infra/crypto/master-key-vault.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

function makeKeyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "va-test-"));
  const path = join(dir, "master.key");
  writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o400 });
  return path;
}

describe("MasterKeyVault", () => {
  it("encrypts and decrypts roundtrip", () => {
    const vault = new MasterKeyVault(makeKeyFile());

    const plaintext = "sk-ant-my-secret-api-key-1234567890";
    const encrypted = vault.encrypt(plaintext);
    const decrypted = vault.decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
    expect(encrypted.ciphertext).not.toEqual(Buffer.from(plaintext));
    expect(encrypted.iv.length).toBe(12);
    expect(encrypted.tag.length).toBe(16);
  });

  it("different IVs produce different ciphertexts for same plaintext", () => {
    const vault = new MasterKeyVault(makeKeyFile());

    const enc1 = vault.encrypt("same-text");
    const enc2 = vault.encrypt("same-text");

    expect(enc1.iv).not.toEqual(enc2.iv);
    expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
  });

  it("wrong tag fails decryption with typed error", () => {
    const vault = new MasterKeyVault(makeKeyFile());

    const enc = vault.encrypt("secret");
    const badTag = Buffer.alloc(16, 0);

    expect(() => vault.decrypt({ ...enc, tag: badTag })).toThrow(CredentialDecryptError);
  });

  it("persists and loads key from explicit file", () => {
    const keyPath = makeKeyFile();
    const vault1 = new MasterKeyVault(keyPath);
    const enc = vault1.encrypt("persistent-test");

    // Second vault reads same explicit key file
    const vault2 = new MasterKeyVault(keyPath);
    const dec = vault2.decrypt(enc);
    expect(dec).toBe("persistent-test");
  });

  it("fails fast when key file is missing", () => {
    expect(() => new MasterKeyVault(join(tmpdir(), "missing-vulnagent-master.key"))).toThrow(/Master key file not found/);
  });

  it("fails fast when key file format is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "va-test-"));
    const path = join(dir, "master.key");
    writeFileSync(path, "not-a-64-char-hex-key");
    expect(() => new MasterKeyVault(path)).toThrow(/64 hex chars/);
  });
});
