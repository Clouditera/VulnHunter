import { beforeEach, describe, expect, it, vi } from "vitest";

const getTaskByIdMock = vi.fn();
const listMock = vi.fn();
const getMock = vi.fn();

vi.mock("../../src/features/tasks/storage.js", () => ({
  getTaskById: getTaskByIdMock,
}));
vi.mock("../../src/features/sandbox-plane/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/features/sandbox-plane/client.js")>(
    "../../src/features/sandbox-plane/client.js",
  );
  return {
    ...actual,
    listSandboxPlaneProfiles: listMock,
    getSandboxPlaneProfile: getMock,
  };
});

const { sandboxPlaneInternalRouter } = await import("../../src/features/sandbox-plane/routes.js");
const { SandboxPlaneUnavailableError } = await import("../../src/features/sandbox-plane/client.js");

function req(path: string, token?: string) {
  return sandboxPlaneInternalRouter.request(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("sandboxPlaneInternalRouter auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing Authorization header", async () => {
    const res = await req("/types");
    expect(res.status).toBe(401);
    expect(getTaskByIdMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown task id", async () => {
    getTaskByIdMock.mockResolvedValue(null);
    const res = await req("/types", "no-such-task");
    expect(res.status).toBe(401);
  });

  it("rejects a task that is not in the preparing state", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "running" });
    const res = await req("/types", "t1");
    expect(res.status).toBe(401);
  });

  it("accepts a task id token for a task currently preparing", async () => {
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "preparing" });
    listMock.mockResolvedValue([]);
    const res = await req("/types", "t1");
    expect(res.status).toBe(200);
  });
});

describe("sandboxPlaneInternalRouter GET /types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "preparing" });
  });

  it("returns the minimal projected shape only", async () => {
    listMock.mockResolvedValue([
      { profile_id: "base-linux", status: "available", backend_type: "docker", capabilities: [] },
      { profile_id: "linux-docker", status: "unavailable", backend_type: "docker+sysbox", capabilities: ["docker"] },
    ]);
    const res = await req("/types", "t1");
    const body = await res.json();
    expect(body).toEqual({
      types: [
        { profile_id: "base-linux", available: true, docker: false, kvm: false, qemu: false },
        { profile_id: "linux-docker", available: false, docker: true, kvm: false, qemu: false },
      ],
    });
  });

  it("fails closed to an empty list on SandboxPlane error, no error detail leaked", async () => {
    listMock.mockRejectedValue(new SandboxPlaneUnavailableError("boom: internal SandboxPlane host detail"));
    const res = await req("/types", "t1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ types: [] });
    expect(JSON.stringify(body)).not.toContain("boom");
  });
});

describe("sandboxPlaneInternalRouter GET /types/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTaskByIdMock.mockResolvedValue({ id: "t1", state: "preparing" });
  });

  it("returns the minimal projected shape for a known profile", async () => {
    getMock.mockResolvedValue({ profile_id: "linux-qemu-system", status: "available", backend_type: "qemu", capabilities: ["kvm", "qemu_system"] });
    const res = await req("/types/linux-qemu-system", "t1");
    const body = await res.json();
    expect(body).toEqual({ type: { profile_id: "linux-qemu-system", available: true, docker: false, kvm: true, qemu: true } });
  });

  it("returns type=null for an unknown profile id", async () => {
    getMock.mockResolvedValue(null);
    const res = await req("/types/no-such", "t1");
    const body = await res.json();
    expect(body).toEqual({ type: null });
  });

  it("fails closed to type=null on SandboxPlane error", async () => {
    getMock.mockRejectedValue(new SandboxPlaneUnavailableError("timeout"));
    const res = await req("/types/base-linux", "t1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ type: null });
  });
});
