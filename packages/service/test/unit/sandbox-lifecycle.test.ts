import { beforeEach, describe, expect, it, vi } from "vitest";

const plane = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
  release: vi.fn(),
  getProfile: vi.fn(),
}));
const store = vi.hoisted(() => ({
  getTaskSandbox: vi.fn(),
  upsertTaskSandbox: vi.fn(),
  updateTaskSandboxState: vi.fn(),
  deleteTaskSandbox: vi.fn(),
  listActiveTaskSandboxes: vi.fn(),
  listTaskSandboxesWithMissingTask: vi.fn(),
  listReadySandboxesOfTerminalTasks: vi.fn(),
  sumRunningSandboxesForUser: vi.fn(),
  blockPendingDynamicStates: vi.fn(),
  sandboxRequestId: (id: string) => `task-${id}-main`,
}));
const authStore = vi.hoisted(() => ({ getUserById: vi.fn() }));

vi.mock("../../src/features/sandbox-plane/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/features/sandbox-plane/client.js")>(
    "../../src/features/sandbox-plane/client.js",
  );
  return {
    ...actual,
    createSandboxPlaneSandbox: plane.create,
    getSandboxPlaneSandbox: plane.get,
    stopSandboxPlaneSandbox: plane.stop,
    resumeSandboxPlaneSandbox: plane.resume,
    releaseSandboxPlaneSandbox: plane.release,
    getSandboxPlaneProfile: plane.getProfile,
  };
});
vi.mock("../../src/features/sandboxes/storage.js", () => store);
vi.mock("../../src/features/auth/storage.js", () => ({ getUserById: authStore.getUserById }));
vi.mock("../../src/infra/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  ensureSandboxForTask,
  stopSandboxForTask,
  resumeSandboxForTask,
  releaseSandboxForTask,
  reconcileSandboxes,
  evaluateQuota,
  ensureTaskSshKeypair,
  peekTaskSshPrivateKey,
  dropTaskSshKeypair,
  SandboxQuotaError,
} = await import("../../src/features/sandboxes/lifecycle.js");
const { SandboxPlaneCapacityError } = await import("../../src/features/sandbox-plane/client.js");

const TASK_ID = "11111111-1111-1111-1111-111111111111";
const runningInstance = (over: Record<string, unknown> = {}) => ({
  sandbox_id: "sb-1",
  request_id: `task-${TASK_ID}-main`,
  consumer: "vulnhunter",
  profile_id: "linux-docker",
  status: "running",
  ssh: { host: "10.0.0.5", port: 22, user: "sandbox" },
  resources: { cpu: 2, memory_mb: 2048 },
  external_ref: TASK_ID,
  failure_reason: null,
  error_code: null,
  ...over,
});
const task = (over: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  created_by: "user-1",
  state: "preparing",
  metadata: { prepare: { sandbox_type: "linux-docker" } },
  source_meta: { dynamic_enabled: true },
  ...over,
}) as any;

beforeEach(() => {
  vi.clearAllMocks();
  dropTaskSshKeypair(TASK_ID);
  store.getTaskSandbox.mockResolvedValue(null);
  store.sumRunningSandboxesForUser.mockResolvedValue({ running: 0, cpu: 0, memory_mb: 0 });
  authStore.getUserById.mockResolvedValue(null);
  plane.getProfile.mockResolvedValue({ profile_id: "linux-docker", status: "available", backend_type: "docker+sysbox", capabilities: ["docker"], default_resources: { cpu: 2, memory_mb: 2048 } });
  plane.create.mockResolvedValue(runningInstance());
  plane.get.mockResolvedValue(runningInstance());
  plane.stop.mockResolvedValue(runningInstance({ status: "stopped" }));
  plane.resume.mockResolvedValue(runningInstance());
  plane.release.mockResolvedValue(runningInstance({ status: "releasing" }));
  store.updateTaskSandboxState.mockResolvedValue(true);
  store.deleteTaskSandbox.mockResolvedValue(true);
});

describe("evaluateQuota matrix (0 = unlimited)", () => {
  const usage = { running: 2, cpu: 4, memory_mb: 4096 };
  const req = { cpu: 2, memory_mb: 2048 };
  it("all-zero limits never block", () => {
    expect(evaluateQuota(usage, { max_running: 0, max_cpu: 0, max_memory_gb: 0 }, req).allowed).toBe(true);
  });
  it("running count: may reach the limit, never exceed it", () => {
    expect(evaluateQuota(usage, { max_running: 3, max_cpu: 0, max_memory_gb: 0 }, req).allowed).toBe(true); // 2+1=3 at limit
    expect(evaluateQuota({ ...usage, running: 3 }, { max_running: 3, max_cpu: 0, max_memory_gb: 0 }, req).allowed).toBe(false); // 3+1>3
  });
  it("cpu sum: may reach the limit, never exceed it", () => {
    expect(evaluateQuota(usage, { max_running: 0, max_cpu: 6, max_memory_gb: 0 }, req).allowed).toBe(true); // 4+2=6 at limit
    expect(evaluateQuota(usage, { max_running: 0, max_cpu: 5, max_memory_gb: 0 }, req).allowed).toBe(false);
  });
  it("memory sum in GB: may reach the limit, never exceed it", () => {
    expect(evaluateQuota(usage, { max_running: 0, max_cpu: 0, max_memory_gb: 6 }, req).allowed).toBe(true); // 4+2=6GB at limit
    expect(evaluateQuota(usage, { max_running: 0, max_cpu: 0, max_memory_gb: 5 }, req).allowed).toBe(false);
  });
});

describe("task ed25519 keypair (H1 handoff)", () => {
  it("produces a valid OpenSSH ssh-ed25519 public line and keeps private key in memory only", () => {
    const { publicKeyOpenSsh } = ensureTaskSshKeypair(TASK_ID);
    expect(publicKeyOpenSsh).toMatch(/^ssh-ed25519 AAAA/);
    const wire = Buffer.from(publicKeyOpenSsh.split(" ")[1]!, "base64");
    // wire format: uint32 len + "ssh-ed25519" + uint32 len + 32-byte raw key
    expect(wire.subarray(4, 15).toString()).toBe("ssh-ed25519");
    expect(wire.length).toBe(4 + 11 + 4 + 32);
    expect(peekTaskSshPrivateKey(TASK_ID)).toContain("PRIVATE KEY-----");
    // stable per task until dropped
    expect(ensureTaskSshKeypair(TASK_ID).publicKeyOpenSsh).toBe(publicKeyOpenSsh);
    dropTaskSshKeypair(TASK_ID);
    expect(peekTaskSshPrivateKey(TASK_ID)).toBeNull();
    expect(ensureTaskSshKeypair(TASK_ID).publicKeyOpenSsh).not.toBe(publicKeyOpenSsh);
  });
});

describe("ensureSandboxForTask", () => {
  it("fresh path: quota gate → create → ready mapping with ssh + resource snapshot", async () => {
    const result = await ensureSandboxForTask(task());
    expect(result.reused).toBe(true); // create returned running directly (idempotent replay shape)
    expect(plane.create).toHaveBeenCalledWith(expect.objectContaining({
      request_id: `task-${TASK_ID}-main`,
      profile_id: "linux-docker",
      external_ref: TASK_ID,
      ssh_public_key: expect.stringMatching(/^ssh-ed25519 /),
    }));
    expect(store.upsertTaskSandbox).toHaveBeenCalledWith(expect.objectContaining({
      task_id: TASK_ID, sandbox_id: "sb-1", state: "ready",
      ssh_host: "10.0.0.5", ssh_port: 22, cpu_cores: 2, memory_mb: 2048,
    }));
  });

  it("reuses an existing ready mapping without any plane call", async () => {
    ensureTaskSshKeypair(TASK_ID); // same-process key present (else recycle)
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    const result = await ensureSandboxForTask(task());
    expect(result.reused).toBe(true);
    expect(plane.create).not.toHaveBeenCalled();
    expect(plane.resume).not.toHaveBeenCalled();
  });

  it("resumes a stopped mapping (continue/restart path)", async () => {
    ensureTaskSshKeypair(TASK_ID);
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "stopped", ssh_host: "10.0.0.5" });
    await ensureSandboxForTask(task());
    expect(plane.resume).toHaveBeenCalledWith("sb-1");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith(TASK_ID, "ready");
    expect(plane.create).not.toHaveBeenCalled();
  });

  it("recycles when the in-memory key was lost (service restart): release + fresh create", async () => {
    // no ensureTaskSshKeypair call — key absent, mapping says ready
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-old", state: "ready" });
    store.getTaskSandbox.mockResolvedValueOnce({ task_id: TASK_ID, sandbox_id: "sb-old", state: "ready" }).mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    await ensureSandboxForTask(task());
    expect(plane.release).toHaveBeenCalledWith("sb-old");
    expect(store.deleteTaskSandbox).toHaveBeenCalledWith(TASK_ID);
    expect(plane.create).toHaveBeenCalled();
  });

  it("resumes when the idempotent replay returns a stopped record", async () => {
    plane.create.mockResolvedValue(runningInstance({ status: "stopped" }));
    await ensureSandboxForTask(task());
    expect(plane.resume).toHaveBeenCalledWith("sb-1");
  });

  it("quota exceeded → SandboxQuotaError with counts, create never called", async () => {
    authStore.getUserById.mockResolvedValue({ sandbox_max_running: 1, sandbox_max_cpu_cores: 0, sandbox_max_memory_gb: 0 });
    store.sumRunningSandboxesForUser.mockResolvedValue({ running: 1, cpu: 2, memory_mb: 2048 });
    await expect(ensureSandboxForTask(task())).rejects.toBeInstanceOf(SandboxQuotaError);
    expect(plane.create).not.toHaveBeenCalled();
  });

  it("capacity 429 propagates as SandboxPlaneCapacityError", async () => {
    plane.create.mockRejectedValue(new SandboxPlaneCapacityError("capacity exhausted"));
    await expect(ensureSandboxForTask(task())).rejects.toBeInstanceOf(SandboxPlaneCapacityError);
  });

  it("P0-2 regression: explicit profileId wins over stale/empty task metadata", async () => {
    // The scheduler gate resolves the selection from the FRESH prepare result
    // while the in-memory task may predate prepare persistence — the explicit
    // param must carry the allocation through without re-reading metadata.
    await ensureSandboxForTask(task({ metadata: {} }), { profileId: "linux-docker" });
    expect(plane.create).toHaveBeenCalledWith(expect.objectContaining({ profile_id: "linux-docker" }));
    expect(store.upsertTaskSandbox).toHaveBeenCalledWith(expect.objectContaining({ profile_id: "linux-docker" }));
  });

  it("missing prepare selection / gone profile are terminal errors", async () => {
    await expect(ensureSandboxForTask(task({ metadata: {} }))).rejects.toThrow(/sandbox_type/);
    plane.getProfile.mockResolvedValue(null);
    await expect(ensureSandboxForTask(task())).rejects.toThrow(/no longer has it/);
  });

  it("instance lost mid-poll is a terminal error", async () => {
    plane.create.mockResolvedValue(runningInstance({ status: "provisioning" }));
    plane.get.mockResolvedValue(null);
    await expect(ensureSandboxForTask(task(), { pollTimeoutMs: 10 })).rejects.toThrow(/disappeared/);
  });

  it("terminal replay (released record) advances the request epoch instead of wedging", async () => {
    plane.create
      .mockResolvedValueOnce(runningInstance({ status: "released", request_id: `task-${TASK_ID}-main` }))
      .mockResolvedValueOnce(runningInstance({ request_id: `task-${TASK_ID}-main-r2` }));
    store.getTaskSandbox.mockResolvedValueOnce(null).mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    const result = await ensureSandboxForTask(task());
    expect(plane.create).toHaveBeenCalledTimes(2);
    expect(plane.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ request_id: `task-${TASK_ID}-main` }));
    expect(plane.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ request_id: `task-${TASK_ID}-main-r2` }));
    expect(store.upsertTaskSandbox).toHaveBeenCalledWith(expect.objectContaining({ request_id: `task-${TASK_ID}-main-r2` }));
    expect(result.mapping).toBeTruthy();
  });

  it("eight straight terminal replays fail loudly", async () => {
    plane.create.mockResolvedValue(runningInstance({ status: "released" }));
    await expect(ensureSandboxForTask(task())).rejects.toThrow(/wedged/);
    expect(plane.create).toHaveBeenCalledTimes(8);
  });
});

describe("stop / resume / release transitions", () => {
  it("stop: ready → stop API → stopped; non-ready is a no-op", async () => {
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    await stopSandboxForTask(TASK_ID);
    expect(plane.stop).toHaveBeenCalledWith("sb-1");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith(TASK_ID, "stopped");

    vi.clearAllMocks();
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "stopped" });
    await stopSandboxForTask(TASK_ID);
    expect(plane.stop).not.toHaveBeenCalled();
  });

  it("stop failure never throws (reconciler retries)", async () => {
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    plane.stop.mockRejectedValue(new Error("plane down"));
    await expect(stopSandboxForTask(TASK_ID)).resolves.toBeUndefined();
    expect(store.updateTaskSandboxState).not.toHaveBeenCalled();
  });

  it("resume: stopped → resume API → ready", async () => {
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "stopped" });
    await resumeSandboxForTask(TASK_ID);
    expect(plane.resume).toHaveBeenCalledWith("sb-1");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith(TASK_ID, "ready");
  });

  it("release: API → released → row dropped; failure marks releasing and throws", async () => {
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "stopped" });
    await releaseSandboxForTask(TASK_ID);
    expect(plane.release).toHaveBeenCalledWith("sb-1");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith(TASK_ID, "released");
    expect(store.deleteTaskSandbox).toHaveBeenCalledWith(TASK_ID);

    vi.clearAllMocks();
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    plane.release.mockRejectedValue(new Error("plane down"));
    await expect(releaseSandboxForTask(TASK_ID)).rejects.toThrow();
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith(TASK_ID, "releasing", expect.any(String));
    expect(store.deleteTaskSandbox).not.toHaveBeenCalled();
  });
});

describe("reconcileSandboxes (crash-window closure)", () => {
  it("rule 2: mapping with missing task → release + drop row", async () => {
    store.listTaskSandboxesWithMissingTask.mockResolvedValue([{ task_id: TASK_ID, sandbox_id: "sb-1", state: "stopped" }]);
    store.listReadySandboxesOfTerminalTasks.mockResolvedValue([]);
    store.listActiveTaskSandboxes.mockResolvedValue([]);
    await reconcileSandboxes();
    expect(plane.release).toHaveBeenCalledWith("sb-1");
    expect(store.deleteTaskSandbox).toHaveBeenCalledWith(TASK_ID);
  });

  it("rule 3: terminal task with ready instance → catch-up stop", async () => {
    store.listTaskSandboxesWithMissingTask.mockResolvedValue([]);
    store.listReadySandboxesOfTerminalTasks.mockResolvedValue([{ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" }]);
    store.listActiveTaskSandboxes.mockResolvedValue([]);
    store.getTaskSandbox.mockResolvedValue({ task_id: TASK_ID, sandbox_id: "sb-1", state: "ready" });
    await reconcileSandboxes();
    expect(plane.stop).toHaveBeenCalledWith("sb-1");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith(TASK_ID, "stopped");
  });

  it("rule 1: instance gone → failed + pending dynamics blocked; externally stopped → align; creating→ready adopt", async () => {
    store.listTaskSandboxesWithMissingTask.mockResolvedValue([]);
    store.listReadySandboxesOfTerminalTasks.mockResolvedValue([]);
    store.listActiveTaskSandboxes.mockResolvedValue([
      { task_id: "t-lost", sandbox_id: "sb-gone", state: "ready" },
      { task_id: "t-stopped", sandbox_id: "sb-stopped", state: "ready" },
      { task_id: "t-creating", sandbox_id: "sb-new", state: "creating" },
      { task_id: "t-releasing", sandbox_id: "sb-rel", state: "releasing" },
    ]);
    plane.get.mockImplementation(async (id: string) =>
      id === "sb-gone" ? null : id === "sb-stopped" ? runningInstance({ sandbox_id: id, status: "stopped" }) : runningInstance({ sandbox_id: id }));
    await reconcileSandboxes();
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith("t-lost", "failed", "instance_lost");
    expect(store.blockPendingDynamicStates).toHaveBeenCalledWith("t-lost");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith("t-stopped", "stopped");
    expect(store.updateTaskSandboxState).toHaveBeenCalledWith("t-creating", "ready");
    // releasing retry: release again → released → row dropped
    expect(plane.release).toHaveBeenCalledWith("sb-rel");
    expect(store.deleteTaskSandbox).toHaveBeenCalledWith("t-releasing");
  });
});
