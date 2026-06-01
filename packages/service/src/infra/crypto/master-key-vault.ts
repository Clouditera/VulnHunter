import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { logger } from "../logger.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM

export interface EncryptedData {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export class CredentialKeyUnavailableError extends Error {
  constructor(message = "Credential encryption key is not configured", cause?: unknown) {
    super(message);
    this.name = "CredentialKeyUnavailableError";
    this.cause = cause;
  }
}

export class CredentialDecryptError extends Error {
  constructor(message = "Credential cannot be decrypted with current master key", cause?: unknown) {
    super(message);
    this.name = "CredentialDecryptError";
    this.cause = cause;
  }
}

export interface MasterKeyInfo {
  source: "file";
  keyPath: string;
  fingerprint: string;
}

export class MasterKeyVault {
  private readonly key: Buffer;
  private readonly info: MasterKeyInfo;

  constructor(keyPath: string) {
    this.key = this.loadKeyFile(keyPath);
    this.info = { source: "file", keyPath, fingerprint: this.computeFingerprint(this.key) };
    logger.debug({ keyInfo: this.info }, "MasterKeyVault initialized");
  }

  getInfo(): MasterKeyInfo {
    return this.info;
  }

  fingerprint(): string {
    return this.info.fingerprint;
  }

  private computeFingerprint(key: Buffer): string {
    return createHash("sha256").update(key).digest("hex").slice(0, 16);
  }

  private loadKeyFile(keyPath: string): Buffer {
    if (!keyPath) {
      throw new Error("VULNAGENT_MASTER_KEY_FILE is required");
    }
    if (!existsSync(keyPath)) {
      throw new Error(`Master key file not found: ${keyPath}`);
    }
    const hex = readFileSync(keyPath, "utf-8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error(`Master key file must contain exactly ${KEY_LENGTH * 2} hex chars: ${keyPath}`);
    }
    logger.info({ path: keyPath }, "Master key loaded from file");
    return Buffer.from(hex, "hex");
  }

  encrypt(plaintext: string): EncryptedData {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  decrypt({ ciphertext, iv, tag }: EncryptedData): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf-8");
    } catch (err) {
      throw new CredentialDecryptError(undefined, err);
    }
  }
}
