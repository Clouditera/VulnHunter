/**
 * Hardware-bound machine identity resolution (HALL-12).
 *
 * Goal: a machine code that survives full reinstall / data-dir cleanup by
 * binding to the host DMI product UUID, without breaking existing installs.
 *
 * Resolution order (migration-safe):
 *  1. legacy_install_id    — an existing `.install_id` is kept byte-for-byte
 *                            so already-activated instances never see their
 *                            machine code change on upgrade. (The enterprise
 *                            license verifier lives outside this repo, so we
 *                            cannot prove a code swap is safe — see PR.)
 *  2. dmi_product_uuid     — fresh installs / wiped data dirs on hosts with a
 *                            valid DMI product UUID derive a versioned,
 *                            irreversible digest: `vhmc_v2_<sha256>`.
 *  3. generated_install_id — no hardware identity available: generate a
 *                            random UUID and persist it atomically (hardlink,
 *                            O_EXCL semantics) so concurrent business/admin
 *                            first-boots converge on one value and readers
 *                            never observe a truncated file.
 *
 * Note: the hardware fingerprint is not a secret and cannot resist forgery
 * by a host root user — the goal is stable binding, not anti-tamper.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type MachineIdentitySource =
  | "dmi_product_uuid"
  | "legacy_install_id"
  | "generated_install_id";

export type MachineIdentity = Readonly<{
  code: string;
  source: MachineIdentitySource;
}>;

/** Container-side default; overridable via VULNHUNTER_DMI_PRODUCT_UUID_PATH (empty = disable DMI binding). */
export const DEFAULT_DMI_PRODUCT_UUID_PATH = "/run/vulnhunter/host/product_uuid";

const INSTALL_ID_FILE = ".install_id";
// Domain separator so v2 machine-code digests can never collide with other
// sha256 uses of the same input.
const MACHINE_CODE_V2_DOMAIN = "vulnhunter/machine-code/v2\n";
const MACHINE_CODE_V2_PREFIX = "vhmc_v2_";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// Corrupt-`.install_id` repair locking: the critical section is a single
// rename, so 30s staleness / 10s wait are generous bounds, not tight timings.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_BUDGET_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 25;

/** Trim + lowercase + format/zero check. Returns null for anything unusable. */
export function normalizeDmiProductUuid(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) return null;
  if (normalized === ZERO_UUID) return null;
  return normalized;
}

/** Read and validate the DMI product UUID file; any I/O or format error → null (caller falls back). */
export function readDmiProductUuid(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // missing / permission denied / not a regular file (e.g. docker created a directory)
    return null;
  }
  return normalizeDmiProductUuid(raw);
}

/** Versioned, irreversible machine code derived from a normalized DMI UUID. Never contains the raw UUID. */
export function deriveMachineCodeFromDmi(dmiUuid: string): string {
  const digest = createHash("sha256").update(MACHINE_CODE_V2_DOMAIN).update(dmiUuid).digest("hex");
  return `${MACHINE_CODE_V2_PREFIX}${digest}`;
}

/** Existing `.install_id` content; null when absent, unreadable, empty, or corrupt (inner whitespace). */
function readLegacyInstallId(filePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const id = raw.trim();
  if (id.length === 0 || /\s/.test(id)) return null;
  return id;
}

/**
 * Exclusive lock via O_EXCL create. Only the lock holder may repair a corrupt
 * `.install_id`, which gives the repair a single owner: the check-then-act gap
 * between "observe corrupt" and "remove corrupt" is closed inside the critical
 * section. A stale lock (holder crashed mid-repair) is broken after
 * LOCK_STALE_MS; the O_EXCL re-create then decides the single new owner.
 */
function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o644));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        continue;
      }
    } catch {
      continue; // lock vanished between check and stat — retry acquire
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for install-id lock ${lockPath}`);
    // Synchronous startup path; Atomics.wait is the portable in-process sleep.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
  }
}

/**
 * Repair a corrupt `.install_id` under the exclusive lock: re-validate inside
 * the critical section (a peer may have repaired it while we waited), then
 * rename the corrupt file aside instead of unlinking it. A file is only ever
 * removed after being re-confirmed corrupt by the single lock holder, so a
 * valid winner linked by a racing peer can never be deleted (HALL-12 review).
 */
function repairCorruptInstallId(filePath: string): void {
  const lockPath = `${filePath}.lock`;
  acquireLock(lockPath);
  try {
    if (readLegacyInstallId(filePath)) return; // a peer repaired it while we waited
    if (!existsSync(filePath)) return; // already moved aside — caller retries the link race
    renameSync(filePath, `${filePath}.corrupt.${process.pid}.${Date.now()}`);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // best effort — a leftover lock is broken by the staleness check above
    }
  }
}

/**
 * Persist a freshly generated UUID with first-writer-wins semantics:
 * write a unique temp file, then link(2) it into place — atomic, and EEXIST
 * tells the loser to adopt the winner's value. Readers therefore never see a
 * truncated `.install_id`, unlike plain writeFileSync from two processes.
 */
function persistGeneratedInstallId(filePath: string): string {
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = randomUUID();
    const tmpPath = `${filePath}.${process.pid}.${attempt}.tmp`;
    writeFileSync(tmpPath, candidate, { mode: 0o644 });
    try {
      linkSync(tmpPath, filePath);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // already linked into place, or never created
      }
    }
    // Lost the link race: adopt a valid winner; repair a corrupt target under
    // the lock and loop to retry the link once the path is clear.
    const existing = readLegacyInstallId(filePath);
    if (existing) return existing;
    repairCorruptInstallId(filePath);
    const repaired = readLegacyInstallId(filePath);
    if (repaired) return repaired;
  }
  // All attempts lost the race — the winner's value must be readable now.
  const existing = readLegacyInstallId(filePath);
  if (existing) return existing;
  throw new Error(`failed to persist generated install id at ${filePath}`);
}

export function resolveMachineIdentity(options: {
  dataDir: string;
  dmiProductUuidPath?: string;
}): MachineIdentity {
  const installIdPath = join(options.dataDir, INSTALL_ID_FILE);

  // 1. Existing installs keep their current machine code unchanged.
  const legacy = readLegacyInstallId(installIdPath);
  if (legacy) return { code: legacy, source: "legacy_install_id" };

  // 2. Fresh installs / wiped data dirs bind to the host DMI product UUID.
  const dmiPath =
    options.dmiProductUuidPath ??
    process.env.VULNHUNTER_DMI_PRODUCT_UUID_PATH ??
    DEFAULT_DMI_PRODUCT_UUID_PATH;
  const dmiUuid = dmiPath.length > 0 ? readDmiProductUuid(dmiPath) : null;
  if (dmiUuid) return { code: deriveMachineCodeFromDmi(dmiUuid), source: "dmi_product_uuid" };

  // 3. No hardware identity: generate once and persist atomically.
  mkdirSync(options.dataDir, { recursive: true });
  return { code: persistGeneratedInstallId(installIdPath), source: "generated_install_id" };
}
