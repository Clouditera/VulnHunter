import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 051 keypair persistence: three-tier read chain (memory -> DB decrypt ->
 * generate+persist) and restart resilience (task-dc82ecce).
 */

const mappingRow: {
  ssh_key_ciphertext: Buffer | null;
  ssh_key_iv: Buffer | null;
  ssh_key_tag: Buffer | null;
} = { ssh_key_ciphertext: null, ssh_key_iv: null, ssh_key_tag: null };

const updateCalls: Array<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }> = [];

vi.mock("../../src/features/sandboxes/storage.js", () => ({
  getTaskSandbox: vi.fn(async () => ({ ...mappingRow })),
  updateTaskSandboxSshKey: vi.fn(async (_id: string, key: { ciphertext: Buffer; iv: Buffer; tag: Buffer }) => {
    updateCalls.push(key);
    mappingRow.ssh_key_ciphertext = key.ciphertext;
    mappingRow.ssh_key_iv = key.iv;
    mappingRow.ssh_key_tag = key.tag;
  }),
}));

const vault = {
  encrypt: (plaintext: string) => ({
    ciphertext: Buffer.from(`enc:${plaintext}`),
    iv: Buffer.from("iv"),
    tag: Buffer.from("tag"),
  }),
  decrypt: ({ ciphertext }: { ciphertext: Buffer }) => {
    const s = ciphertext.toString();
    if (!s.startsWith("enc:")) throw new Error("bad key");
    return s.slice(4);
  },
};

vi.mock("../../src/features/settings/storage.js", () => ({
  getVaultOptional: vi.fn(() => vault),
}));

const {
  ensureTaskSshKeypair,
  storeTaskSshKeypair,
  loadTaskSshKeypair,
  peekTaskSshPrivateKey,
  hasTaskSshKeypair,
  dropTaskSshKeypair,
} = await import("../../src/features/sandboxes/lifecycle.js");

describe("task ssh keypair persistence (051)", () => {
  beforeEach(() => {
    mappingRow.ssh_key_ciphertext = null;
    mappingRow.ssh_key_iv = null;
    mappingRow.ssh_key_tag = null;
    updateCalls.length = 0;
    dropTaskSshKeypair("task-x");
  });

  it("store encrypts the in-memory private key onto the mapping row", async () => {
    ensureTaskSshKeypair("task-x");
    await storeTaskSshKeypair("task-x");
    expect(updateCalls).toHaveLength(1);
    expect(mappingRow.ssh_key_ciphertext?.toString()).toContain("enc:-----BEGIN OPENSSH PRIVATE KEY-----");
  });

  it("restart simulation: memory cleared -> peek rehydrates from DB (same key)", async () => {
    const { publicKeyOpenSsh } = ensureTaskSshKeypair("task-x");
    const before = await peekTaskSshPrivateKey("task-x");
    await storeTaskSshKeypair("task-x");

    // Simulate service restart: memory is gone.
    dropTaskSshKeypair("task-x");
    expect(hasTaskSshKeypair("task-x")).toBe(false);

    expect(await loadTaskSshKeypair("task-x")).toBe(true);
    const after = await peekTaskSshPrivateKey("task-x");
    expect(after).toBe(before);
    // Public half must be correctly re-derived from the OpenSSH private blob
    // (parsed from the openssh-key-v1 wire layout).
    expect(ensureTaskSshKeypair("task-x").publicKeyOpenSsh).toBe(publicKeyOpenSsh);
  });

  it("no DB key and no memory -> peek returns null (recycle path applies)", async () => {
    expect(await loadTaskSshKeypair("task-x")).toBe(false);
    expect(await peekTaskSshPrivateKey("task-x")).toBeNull();
  });

  it("undecryptable DB key -> load returns false and does not poison memory", async () => {
    mappingRow.ssh_key_ciphertext = Buffer.from("garbage");
    mappingRow.ssh_key_iv = Buffer.from("iv");
    mappingRow.ssh_key_tag = Buffer.from("tag");
    expect(await loadTaskSshKeypair("task-x")).toBe(false);
    expect(hasTaskSshKeypair("task-x")).toBe(false);
  });
});
