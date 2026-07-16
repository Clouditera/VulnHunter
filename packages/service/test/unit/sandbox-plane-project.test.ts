import { describe, expect, it } from "vitest";
import { projectSandboxType, projectSandboxTypes } from "../../src/features/sandbox-plane/project.js";
import type { SandboxPlaneRawProfile } from "../../src/features/sandbox-plane/client.js";

function raw(overrides: Partial<SandboxPlaneRawProfile> = {}): SandboxPlaneRawProfile {
  return {
    profile_id: "base-linux",
    status: "available",
    backend_type: "docker",
    capabilities: [],
    ...overrides,
  };
}

describe("projectSandboxType", () => {
  it("projects a plain profile with no capability flags", () => {
    expect(projectSandboxType(raw())).toEqual({
      profile_id: "base-linux",
      available: true,
      docker: false,
      kvm: false,
      qemu: false,
    });
  });

  it("sets docker=true only from the docker capability, not backend_type alone", () => {
    const dockerBackendNoCap = raw({ profile_id: "x", backend_type: "docker+sysbox", capabilities: [] });
    expect(projectSandboxType(dockerBackendNoCap).docker).toBe(false);

    const dockerCap = raw({ profile_id: "linux-docker", backend_type: "docker+sysbox", capabilities: ["ssh", "shell", "docker", "compose"] });
    expect(projectSandboxType(dockerCap).docker).toBe(true);
  });

  it("sets kvm/qemu=true only from kvm/qemu_system capabilities", () => {
    const qemuProfile = raw({
      profile_id: "linux-qemu-system",
      backend_type: "qemu",
      capabilities: ["ssh", "shell", "qemu_system", "qemu_img", "kvm", "sftp"],
    });
    const projected = projectSandboxType(qemuProfile);
    expect(projected.kvm).toBe(true);
    expect(projected.qemu).toBe(true);
    expect(projected.docker).toBe(false);
  });

  it("maps status to available boolean, unavailable and disabled both project to false", () => {
    expect(projectSandboxType(raw({ status: "unavailable" })).available).toBe(false);
    expect(projectSandboxType(raw({ status: "disabled" })).available).toBe(false);
    expect(projectSandboxType(raw({ status: "available" })).available).toBe(true);
  });

  it("never leaks fields beyond the minimal contract", () => {
    const projected = projectSandboxType(raw({ status: "available", capabilities: ["docker"] }));
    expect(Object.keys(projected).sort()).toEqual(["available", "docker", "kvm", "profile_id", "qemu"]);
  });

  it("projects a full list in order", () => {
    const list = projectSandboxTypes([
      raw({ profile_id: "base-linux", capabilities: [] }),
      raw({ profile_id: "linux-docker", backend_type: "docker+sysbox", capabilities: ["docker"] }),
      raw({ profile_id: "linux-qemu-system", backend_type: "qemu", capabilities: ["kvm", "qemu_system"], status: "unavailable" }),
    ]);
    expect(list).toEqual([
      { profile_id: "base-linux", available: true, docker: false, kvm: false, qemu: false },
      { profile_id: "linux-docker", available: true, docker: true, kvm: false, qemu: false },
      { profile_id: "linux-qemu-system", available: false, docker: false, kvm: true, qemu: true },
    ]);
  });
});
