/**
 * Dynamic-verification provider seam (community removal, architect spec
 * task-8a290a7d ①). The community edition physically carries no sandbox
 * modules — this registry is the ONLY surface core code touches; the
 * enterprise/saas packages register the real implementation at boot
 * (initEnterprise → setDynamicProvider). Default = null provider: allocation
 * is a no-op that behaves as "not configured", lifecycle callbacks are
 * passthrough, capacity is unconfigured.
 *
 * The seam deliberately speaks in core-owned primitives (DbTask shape
 * subset, plain result objects) so the provider module has no core imports
 * back into features/sandboxes — that physical split is the point.
 */

import type { DbTask } from "../tasks/storage.js";
import { logger } from "../../infra/logger.js";

/** Sandbox mapping as seen by core call sites (worker injection needs the
 * full SSH coordinate set). Field-for-field superset of the storage row's
 * public shape; ssh_key_* ciphertext fields stay provider-internal. */
export interface DynamicSandboxMapping {
  task_id: string;
  sandbox_id: string;
  consumer: string;
  request_id: string;
  profile_id: string;
  arch: string | null;
  os: string | null;
  cpu_cores: number | null;
  memory_mb: number | null;
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  /** Docker-internal IP for bastion ProxyJump (SandboxPlane v0.3.2). */
  ssh_internal_host: string | null;
  /** Instance host public key for StrictHostKeyChecking pin (#7). */
  ssh_host_public_key: string | null;
  host_key: string | null;
  state: "creating" | "ready" | "stopped" | "releasing" | "released" | "failed";
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnsureSandboxResult {
  mapping: DynamicSandboxMapping;
  reused: boolean;
}

/** Allocation rejection taxonomy (scheduler requeue logic keys off it). */
export type SandboxAllocErrorKind = "quota" | "capacity" | "plane_unavailable" | "type_unavailable";

export class DynamicAllocationError extends Error {
  readonly kind: SandboxAllocErrorKind;
  constructor(kind: SandboxAllocErrorKind, message: string) {
    super(message);
    this.name = "DynamicAllocationError";
    this.kind = kind;
  }
}

export interface DynamicVerificationProvider {
  /** Human id for logs (e.g. "enterprise-sandbox-plane"). */
  readonly name: string;

  /** Allocate (or recycle) the sandbox for a dynamic task. Throws
   * DynamicAllocationError for quota/capacity rejections — the scheduler's
   * requeue/backoff path keys off error.kind. */
  ensureSandboxForTask(task: DbTask, opts?: { profileId?: string; pollTimeoutMs?: number }): Promise<EnsureSandboxResult>;

  /** Terminal stop (keep instance) — H2 §4. Never throws into callers. */
  stopSandboxForTask(taskId: string, reason?: string): Promise<void>;

  /** Resume a stopped sandbox before the task resumes (pause ⇄ resume). */
  resumeSandboxForTask(taskId: string): Promise<void>;

  /** Release on task delete. Never blocks deletion. */
  releaseSandboxForTask(taskId: string): Promise<void>;

  /** Periodic orphan/leak reconciliation (service tick). */
  reconcileSandboxes(): Promise<void>;

  /** Current mapping for a task, or null. */
  getTaskSandbox(taskId: string): Promise<DynamicSandboxMapping | null>;

  /** In-memory SSH private key peek (continue/resume path). Null = none. */
  peekTaskSshPrivateKey(taskId: string): Promise<string | null>;

  /** Whether the sandbox plane is configured (MCP tool descriptions etc.). */
  isConfigured(): boolean;
}

/** Null provider: community default — nothing configured, everything no-ops. */
class NullDynamicProvider implements DynamicVerificationProvider {
  readonly name = "null";

  async ensureSandboxForTask(): Promise<EnsureSandboxResult> {
    throw new DynamicAllocationError("plane_unavailable", "dynamic verification not available in this edition");
  }
  async stopSandboxForTask(): Promise<void> {}
  async resumeSandboxForTask(): Promise<void> {}
  async releaseSandboxForTask(): Promise<void> {}
  async reconcileSandboxes(): Promise<void> {}
  async getTaskSandbox(): Promise<DynamicSandboxMapping | null> {
    return null;
  }
  async peekTaskSshPrivateKey(): Promise<string | null> {
    return null;
  }
  isConfigured(): boolean {
    return false;
  }
}

let provider: DynamicVerificationProvider = new NullDynamicProvider();

/** Register the real provider (enterprise/saas boot). One-shot per process. */
export function setDynamicProvider(p: DynamicVerificationProvider): void {
  provider = p;
  logger.info({ provider: p.name }, "Dynamic verification provider registered");
}

export function getDynamicProvider(): DynamicVerificationProvider {
  return provider;
}
