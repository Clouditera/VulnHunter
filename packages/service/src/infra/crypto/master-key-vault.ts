import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM

export interface EncryptedData {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export class MasterKeyVault {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    this.key = this.loadOrGenerateKey(dataDir);
    logger.debug("MasterKeyVault initialized");
  }

  private loadOrGenerateKey(dataDir: string): Buffer {
    // Priority 1: env variable (32 bytes hex)
    const envKey = process.env.VULNHUNT_MASTER_KEY;
    if (envKey) {
      const buf = Buffer.from(envKey, "hex");
      if (buf.length !== KEY_LENGTH) {
        throw new Error(
          `VULNHUNT_MASTER_KEY must be ${KEY_LENGTH * 2} hex chars (got ${envKey.length})`,
        );
      }
      logger.info("Master key loaded from VULNHUNT_MASTER_KEY env");
      return buf;
    }

    // Priority 2: file
    const keyPath = join(dataDir, ".master.key");
    if (existsSync(keyPath)) {
      const hex = readFileSync(keyPath, "utf-8").trim();
      logger.info({ path: keyPath }, "Master key loaded from file");
      return Buffer.from(hex, "hex");
    }

    // Generate and persist
    const key = randomBytes(KEY_LENGTH);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o400 });
    logger.info({ path: keyPath }, "Master key generated and persisted");
    return key;
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
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf-8");
  }
}
