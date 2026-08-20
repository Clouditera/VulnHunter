import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
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

  it("replaces a stale empty .install_id instead of crashing, keeping the corrupt file aside", () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".install_id"), "");

    const identity = resolveMachineIdentity({
      dataDir: dir,
      dmiProductUuidPath: join(dir, "no-dmi"),
    });

    expect(identity.source).toBe("generated_install_id");
    expect(identity.code).toMatch(UUID_PATTERN);
    expect(readFileSync(join(dir, ".install_id"), "utf-8")).toBe(identity.code);
    // The corrupt file is renamed aside (never unlinked); no lock/tmp residue.
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.startsWith(".install_id.corrupt."))).toHaveLength(1);
    expect(entries.filter((e) => e.endsWith(".lock") || e.includes(".tmp"))).toEqual([]);
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

/**
 * Multi-process determinism/stress check (HALL-12 review blocker 1):
 * pre-plant a corrupt `.install_id`, then run N concurrent OS processes
 * against the same dataDir. The lock-owned repair must never delete a valid
 * winner, so every process must converge on the same id.
 *
 * Children are plain `node` processes, so the TS module is transpiled to a
 * temp .mjs via the TypeScript devDependency (hermetic, no build step).
 */
describe("resolveMachineIdentity — multi-process race with corrupt .install_id", () => {
  const execFileAsync = promisify(execFile);

  function writeRunner(dir: string): string {
    const src = readFileSync(
      resolve(__dirname, "../../src/features/system/machine-identity.ts"),
      "utf-8",
    );
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const modPath = join(dir, "machine-identity.mjs");
    writeFileSync(modPath, js);
    const runner = join(dir, "runner.mjs");
    const runnerSource = [
      `import { resolveMachineIdentity } from ${JSON.stringify(pathToFileURL(modPath).href)};`,
      "const r = resolveMachineIdentity({ dataDir: process.argv[2], dmiProductUuidPath: process.argv[3] });",
      "process.stdout.write(r.code);",
      "",
    ].join("\n");
    writeFileSync(runner, runnerSource);
    return runner;
  }

  it("8 concurrent processes converge on one repaired id and never lose a winner", async () => {
    const dir = makeDir();
    writeFileSync(join(dir, ".install_id"), ""); // corrupt: empty
    const runner = writeRunner(dir);
    const noDmi = join(dir, "no-dmi");

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(process.execPath, [runner, dir, noDmi]).then((r) => r.stdout.trim()),
      ),
    );

    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toMatch(UUID_PATTERN);
    expect(readFileSync(join(dir, ".install_id"), "utf-8")).toBe(outcomes[0]);
    // Corrupt file preserved aside; no lock/tmp residue left behind.
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.startsWith(".install_id.corrupt."))).toHaveLength(1);
    expect(entries.filter((e) => e.endsWith(".lock") || e.includes(".tmp"))).toEqual([]);
  }, 30_000);

  it("repeated corrupt-plant + concurrent rounds stay convergent (stress)", async () => {
    for (let round = 0; round < 3; round++) {
      const dir = makeDir();
      writeFileSync(join(dir, ".install_id"), "\n\n"); // corrupt: whitespace-only
      const runner = writeRunner(dir);
      const noDmi = join(dir, "no-dmi");

      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () =>
          execFileAsync(process.execPath, [runner, dir, noDmi]).then((r) => r.stdout.trim()),
        ),
      );

      expect(new Set(outcomes).size).toBe(1);
      expect(readFileSync(join(dir, ".install_id"), "utf-8")).toBe(outcomes[0]);
    }
  }, 60_000);
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
