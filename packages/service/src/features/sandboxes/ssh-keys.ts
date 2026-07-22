/**
 * Per-task ed25519 keypair handling for the H1 SSH execution backend.
 * OpenSSH wire formats are built here so the private key never needs a
 * library/system dependency and never touches disk outside the worker tmpfs.
 *
 * Key facts (H1 §2): generate at sandbox create; public key goes to
 * SandboxPlane once; private key only into the worker tmpfs (0400);
 * lifetime == task lifetime; no rotation, no DB, no env, no logs.
 */

import { generateKeyPairSync } from "node:crypto";

const SSH_ALG = "ssh-ed25519";

function packString(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

function packUint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

export interface TaskSshKeypair {
  /** `ssh-ed25519 AAAA...` authorized_keys line. */
  publicKeyOpenSsh: string;
  /** Full `-----BEGIN OPENSSH PRIVATE KEY-----` file content (unencrypted). */
  privateKeyOpenSsh: string;
}

export function generateTaskSshKeypair(): TaskSshKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
  const rawPublic = Buffer.from(pubJwk.x, "base64url");
  const rawPrivate = Buffer.from(privJwk.d, "base64url");
  if (rawPublic.length !== 32 || rawPrivate.length !== 32) {
    throw new Error("Unexpected ed25519 key material length");
  }

  // Public blob: string "ssh-ed25519" + string raw-public-key
  const publicBlob = Buffer.concat([packString(Buffer.from(SSH_ALG, "ascii")), packString(rawPublic)]);
  const publicKeyOpenSsh = `${SSH_ALG} ${publicBlob.toString("base64")}`;

  // openssh-key-v1 private format (ciphername/kdfname "none"):
  //   "openssh-key-v1\0" + string ciphername + string kdfname + string kdfoptions
  //   + uint32 nkeys(=1) + string public-blob
  //   + string private-section(checkint x2, string alg, string pub, string priv(64B), string comment, pad 1..n)
  const privateSecret = Buffer.concat([rawPrivate, rawPublic]); // 64 bytes per OpenSSH ed25519 convention
  const check = Buffer.alloc(4);
  // Random checkint is fine; a fixed one is also accepted and keeps output deterministic per key.
  check.writeUInt32BE(0x1a2b3c4d, 0);
  const privateSection = Buffer.concat([
    check,
    check,
    packString(Buffer.from(SSH_ALG, "ascii")),
    packString(rawPublic),
    packString(privateSecret),
    packString(Buffer.from("vulnhunter-task", "ascii")),
  ]);
  const blockSize = 8;
  const padded: Buffer[] = [privateSection];
  for (let i = 1; privateSection.length % blockSize !== 0 && padded.reduce((n, b) => n + b.length, 0) % blockSize !== 0; i++) {
    padded.push(Buffer.from([i & 0xff]));
  }
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    packString(Buffer.from("none", "ascii")),
    packString(Buffer.from("none", "ascii")),
    packString(Buffer.alloc(0)),
    packUint32(1),
    packString(publicBlob),
    packString(Buffer.concat(padded)),
  ]);
  const b64 = body.toString("base64");
  const lines = b64.match(/.{1,70}/g) ?? [];
  const privateKeyOpenSsh = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;

  return { publicKeyOpenSsh, privateKeyOpenSsh };
}
