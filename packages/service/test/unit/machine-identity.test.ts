import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getInstallationId, initInstallation } from "../../src/features/system/installation.js";
import {
  deriveMachineCodeFromDmi,
  normalizeDmiProductUuid,
  resolveMachineIdentity,
} from "../../src/features/system/machine-identity.js";

const DMI_UUID = "4c4c4544-0052-4d10-8053-b8c04f385432";
const DMI_UUID_OTHER = "03000200-0400-0500-0006-000700080009";
const V2_CODE_PATTERN = /^vhmc_v2_[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "vh-machine-identity-"));
}

function writeDmiFile(dir: string, content: string): string {
  const path = join(dir, "product_uuid");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env coerces assignments to strings; `= undefined` would leak the literal "undefined".
  delete process.env.VULNHUNTER_DMI_PRODUCT_UUID_PATH;
});

describe("normalizeDmiProductUuid", () => {
  it("accepts a valid UUID and normalizes case/whitespace", () => {
    expect(normalizeDmiProductUuid(`  ${DMI_UUID.toUpperCase()}\n`)).toBe(DMI_UUID);
  });

  it("rejects empty, all-zero and malformed values", () => {
    expect(normalizeDmiProductUuid("")).toBeNull();
    expect(normalizeDmiProductUuid("   \n")).toBeNull();
    expect(normalizeDmiProductUuid("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(normalizeDmiProductUuid("not-a-uuid")).toBeNull();
    expect(normalizeDmiProductUuid("4c4c4544-0052-4d10-8053-b8c04f38543")).toBeNull(); // too short
    expect(normalizeDmiProductUuid(`${DMI_UUID}extra`)).toBeNull();
  });
});

describe("resolveMachineIdentity — legacy .install_id", () => {
  it("keeps an existing .install_id byte-for-byte even when a valid DMI UUID is present", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".install_id"), "11111111-2222-3333-4444-555555555555\n");
    const dmiPath = writeDmiFile(dir, `${DMI_UUID}\n`);

    const identity = resolveMachineIdentity({ dataDir: dir, dmiProductUuidPath: dmiPath });

    expect(identity.source).toBe("legacy_install_id");
    expect(identity.code).toBe("11111111-2222-3333-4444-555555555555");
  });
});

describe("resolveMachineIdentity — DMI product UUID", () => {
  it("derives a stable v2 code across data-dir cleanup and reinstall", () => {
    const dmiPath = writeDmiFile(makeDir(), `${DMI_UUID}\n`);
    const first = resolveMachineIdentity({ dataDir: makeDir(), dmiProductUuidPath: dmiPath });
    // Simulate full reinstall / wiped data dir: brand-new dataDir, same DMI.
    const second = resolveMachineIdentity({ dataDir: makeDir(), dmiProductUuidPath: dmiPath });

    expect(first.source).toBe("dmi_product_uuid");
    expect(first.code).toMatch(V2_CODE_PATTERN);
    expect(second.code).toBe(first.code);
  });

  it("is insensitive to DMI file case and trailing newline", () => {
    const lower = writeDmiFile(makeDir(), `${DMI_UUID}\n`);
    const upper = writeDmiFile(makeDir(), DMI_UUID.toUpperCase());

    const a = resolveMachineIdentity({ dataDir: makeDir(), dmiProductUuidPath: lower });
    const b = resolveMachineIdentity({ dataDir: makeDir(), dmiProductUuidPath: upper });

    expect(a.code).toBe(b.code);
  });

  it("derives different codes for different DMI UUIDs and never leaks the raw UUID", () => {
    const pathA = writeDmiFile(makeDir(), DMI_UUID);
    const pathB = writeDmiFile(makeDir(), DMI_UUID_OTHER);

    const a = resolveMachineIdentity({ dataDir: makeDir(), dmiProductUuidPath: pathA });
    const b = resolveMachineIdentity({ dataDir: makeDir(), dmiProductUuidPath: pathB });

    expect(a.code).not.toBe(b.code);
    expect(a.code).not.toContain(DMI_UUID);
    expect(a.code.toLowerCase()).not.toContain(DMI_UUID.replace(/-/g, ""));
  });
});

describe("resolveMachineIdentity — DMI fallback", () => {
  it("falls back to an existing .install_id when the DMI file is missing/empty/zero/invalid", () => {
    for (const content of [undefined, "", "00000000-0000-0000-0000-000000000000\n", "garbage\n"]) {
      const dir = makeDir();
      writeFileSync(join(dir, ".install_id"), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      let dmiPath = join(dir, "product_uuid");
      if (content !== undefined) writeDmiFile(dir, content);
      else dmiPath = join(dir, "does-not-exist");

      const identity = resolveMachineIdentity({ dataDir: dir, dmiProductUuidPath: dmiPath });

      expect(identity.source).toBe("legacy_install_id");
      expect(identity.code).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    }
  });

  it("treats a directory at the DMI path (docker auto-created mount) as unavailable", () => {
    const dir = makeDir();
    const dmiDir = join(dir, "product_uuid");
    mkdirSync(dmiDir);

    const identity = resolveMachineIdentity({ dataDir: dir, dmiProductUuidPath: dmiDir });

    expect(identity.source).toBe("generated_install_id");
    expect(identity.code).toMatch(UUID_PATTERN);
  });

  it("honors VULNHUNTER_DMI_PRODUCT_UUID_PATH and treats an empty override as disabled", () => {
    const dmiPath = writeDmiFile(makeDir(), DMI_UUID);
    process.env.VULNHUNTER_DMI_PRODUCT_UUID_PATH = dmiPath;
    const viaEnv = resolveMachineIdentity({ dataDir: makeDir() });
    expect(viaEnv.source).toBe("dmi_product_uuid");

    process.env.VULNHUNTER_DMI_PRODUCT_UUID_PATH = "";
    const disabled = resolveMachineIdentity({ dataDir: makeDir() });
    expect(disabled.source).toBe("generated_install_id");
  });
});

describe("resolveMachineIdentity — generated fallback", () => {
  it("generates once, persists, and converges on the same value for subsequent initializers", () => {
    const dir = makeDir();
    const dmiMissing = join(dir, "no-dmi");

    const first = resolveMachineIdentity({ dataDir: dir, dmiProductUuidPath: dmiMissing });
    // Second initializer (the other container) sees the persisted file.
    const second = resolveMachineIdentity({ dataDir: dir, dmiProductUuidPath: dmiMissing });

    expect(first.source).toBe("generated_install_id");
    expect(second.code).toBe(first.code);
    expect(readFileSync(join(dir, ".install_id"), "utf-8")).toBe(first.code);
  });

  it("replaces a stale empty .install_id instead of crashing", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".install_id"), "");

    const identity = resolveMachineIdentity({
      dataDir: dir,
      dmiProductUuidPath: join(dir, "no-dmi"),
    });

    expect(identity.source).toBe("generated_install_id");
    expect(identity.code).toMatch(UUID_PATTERN);
    expect(readFileSync(join(dir, ".install_id"), "utf-8")).toBe(identity.code);
  });

  it("leaves no temp files behind", () => {
    const dir = makeDir();
    const identity = resolveMachineIdentity({
      dataDir: dir,
      dmiProductUuidPath: join(dir, "no-dmi"),
    });
    expect(readdirSync(dir)).toEqual([".install_id"]);
  });
});

describe("initInstallation / getInstallationId compatibility", () => {
  it("exposes the resolved identity through the existing getInstallationId() API", () => {
    const dir = makeDir();
    const dmiPath = writeDmiFile(dir, DMI_UUID);
    process.env.VULNHUNTER_DMI_PRODUCT_UUID_PATH = dmiPath;

    initInstallation(dir);

    expect(getInstallationId()).toBe(deriveMachineCodeFromDmi(DMI_UUID));
  });
});
