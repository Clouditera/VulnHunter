import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * task-ac572a8e B: idle sandbox release + continue/resume re-ensure.
 * Continue/resume on a dynamic task whose sandbox was released (mapping gone
 * / state=released) must re-ensure (idempotent) and re-peek the NEW private
 * key — never reuse the old one. Fresh tasks without a ready mapping still
 * spawn sandbox-less (gate allocates later). ensure failure stays fail-loud
 * on resume/continue.
 */

const m = vi.hoisted(() => ({
  // provider fake state — `mapping` is what getTaskSandbox reports (possibly
  // stale/released); `ensureMapping` is what a successful ensure returns
  // (real allocation always returns a usable sandbox).
  mapping: null as any,
  ensureMapping: null as any,
  privateKey: null as string | null,
  ensureCalls: 0,
  ensureProfileIds: [] as (string | undefined)[],
  ensureError: null as any,
  injected: [] as any[],
  // docker
  containers: {} as Record<string, any>,
}));

vi.mock("../../src/features/dynamic/provider.js", () => {
  const fake = {
    name: "test",
    ensureSandboxForTask: async (_task: unknown, opts?: { profileId?: string }) => {
      m.ensureCalls++;
      m.ensureProfileIds.push(opts?.profileId);
      if (m.ensureError) throw m.ensureError;
      return { mapping: m.ensureMapping, reused: true };
    },
    getTaskSandbox: async () => m.mapping,
    peekTaskSshPrivateKey: async () => m.privateKey,
    injectSandboxFiles: async (container: unknown, mapping: any, key: string) => {
      m.injected.push({ container, mapping, key });
    },
    isConfigured: () => true,
  };
  return {
    setDynamicProvider: () => {},
    getDynamicProvider: () => fake,
    DynamicAllocationError: class extends Error {
      kind = "plane_unavailable";
    },
  };
});

vi.mock("../../src/features/workers/docker-client.js", () => ({
  getDocker: () => ({
    getContainer: (id: string) => ({
      inspect: async () => {
        if (!m.containers[id]) {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        }
        return { Config: { Labels: {} }, State: { Status: "running" } };
      },
      start: async () => undefined,
    }),
  }),
  createWorkerContainer: vi.fn(async (args: { taskId: string }) => {
    const id = `ctr-${args.taskId}`;
    m.containers[id] = { id };
    return { id, start: vi.fn(async () => undefined) };
  }),
  LABEL_TASK_ID: "vulnhunter.task_id",
  LABEL_TASK_TYPE: "vulnhunter.task_type",
  LABEL_SCHEDULER_CLAIM: "vulnhunter.scheduler_claim",
  ensureWorkDir: vi.fn(),
}));

vi.mock("../../src/infra/config.js", () => ({
  loadConfig: () => ({
    dataDir: "/tmp/ttl-test",
    docker: { workerImage: "w:1", network: "n" },
    minio: { endpoint: "e", port: 9000, accessKey: "a", secretKey: "s", bucket: "b" },
    sandboxSshHostOverride: null,
    sandboxSshBastion: null,
    sandboxSshBastionHostKey: null,
    sandboxSshBastionIdentity: null,
  }),
}));
vi.mock("../../src/features/tasks/storage.js", () => ({
  mergeTaskMetadata: vi.fn(async () => undefined),
}));
vi.mock("../../src/infra/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/features/workers/scan-inputs.js", () => ({
  scanInputEnvFromMeta: vi.fn(() => ({})),
}));
vi.mock("../../src/features/workers/sandbox-config.js", () => ({
  renderSandboxMd: vi.fn(() => "sandbox md"),
}));
vi.mock("../../src/features/workers/audit-completion.js", () => ({
  createAuditCompletionEngineRun: vi.fn(() => ({ run_id: "r" })),
  fingerprintAuditCompletion: vi.fn(() => "fp"),
}));

const { spawnScanWorker } = await import("../../src/features/workers/scan-worker.js");

const FULL_CONFIG = {
  dataDir: "/tmp/ttl-test",
  docker: { workerImage: "w:1", network: "n" },
  minio: { endpoint: "e", port: 9000, accessKey: "a", secretKey: "s", bucket: "b" },
  sandboxSshHostOverride: null,
  sandboxSshBastion: null,
  sandboxSshBastionHostKey: null,
  sandboxSshBastionIdentity: null,
} as any;
const BASE_TASK = {
  id: "task-ttl-1",
  source_meta: { dynamic_enabled: true },
  metadata: { prepare: { sandbox_capabilities: [] }, sandbox_alloc: { profile_id: "linux-docker" } },
} as any;
const CONFIG = {
  dataDir: "/tmp/ttl-test",
  docker: { workerImage: "w:1", network: "n" },
  minio: { endpoint: "e", port: 9000, accessKey: "a", secretKey: "s", bucket: "b" },
  sandboxSshHostOverride: null,
  sandboxSshBastion: null,
  sandboxSshBastionHostKey: null,
  sandboxSshBastionIdentity: null,
} as any;
const MAPPING_READY = { sandbox_id: "sb-2", profile_id: "linux-docker", state: "ready" };

beforeEach(() => {
  m.mapping = null;
  m.ensureMapping = { sandbox_id: "sb-2", profile_id: "linux-docker", state: "ready" };
  m.privateKey = null;
  m.ensureCalls = 0;
  m.ensureProfileIds = [];
  m.ensureError = null;
  m.injected = [];
  m.containers = {};
});

describe("continue/resume sandbox re-ensure (idle release, task-ac572a8e B)", () => {
  it("re-ensures when mapping is released and injects the NEW private key", async () => {
    m.mapping = { ...MAPPING_READY, state: "released" };
    m.privateKey = "new-key";
    await spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-1", false, true);
    expect(m.ensureCalls).toBe(1);
    expect(m.ensureProfileIds).toEqual(["linux-docker"]);
    expect(m.injected).toHaveLength(1);
    expect(m.injected[0].key).toBe("new-key");
    expect(m.injected[0].mapping.sandbox_id).toBe("sb-2");
  });

  it("re-ensures when the mapping is gone entirely", async () => {
    m.mapping = null;
    // ensure allocates a fresh sandbox + NEW keypair; the key appears for the
    // post-ensure re-peek (the code must NOT have peeked before ensure).
    m.privateKey = "reensure-key";
    await spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-2", false, true);
    expect(m.ensureCalls).toBe(1);
    expect(m.injected).toHaveLength(1);
  });

  it("does NOT ensure when a ready sandbox + key already exist", async () => {
    m.mapping = { ...MAPPING_READY };
    m.privateKey = "existing-key";
    await spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-3", false, true);
    expect(m.ensureCalls).toBe(0);
    expect(m.injected[0].key).toBe("existing-key");
  });

  it("re-ensures on resume with released sandbox (same branch as continue)", async () => {
    m.mapping = { ...MAPPING_READY, state: "failed" };
    m.privateKey = "k2";
    await spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-4", true, false);
    expect(m.ensureCalls).toBe(1);
    expect(m.injected).toHaveLength(1);
  });

  it("stays fail-loud when ensure throws on continue (plane unavailable)", async () => {
    m.mapping = null;
    m.ensureError = Object.assign(new Error("plane down"), { kind: "plane_unavailable" });
    await expect(spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-5", false, true)).rejects.toThrow(/plane down/);
    expect(m.injected).toHaveLength(0);
  });

  it("fresh dynamic task without mapping still spawns sandbox-less (no ensure)", async () => {
    m.mapping = null;
    m.privateKey = null;
    await spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-6", false, false);
    expect(m.ensureCalls).toBe(0);
    expect(m.injected).toHaveLength(0);
  });

  it("fails loud when re-ensure leaves mapping non-ready (broken pipeline)", async () => {
    m.mapping = null;
    // ensure "succeeds" but returns a non-ready mapping (simulate race)
    vi.mocked(await import("../../src/features/dynamic/provider.js")).getDynamicProvider;
    const mod = await import("../../src/features/dynamic/provider.js");
    // swap ensure result via the hoisted state: point mapping at a pending state
    const fake = (mod as any).getDynamicProvider();
    const orig = fake.ensureSandboxForTask;
    fake.ensureSandboxForTask = async () => ({ mapping: { sandbox_id: "sb-x", state: "creating" }, reused: false });
    await expect(spawnScanWorker(BASE_TASK, FULL_CONFIG, {}, "tok-7", false, true)).rejects.toThrow(/requires a ready sandbox/);
    fake.ensureSandboxForTask = orig;
  });
});
