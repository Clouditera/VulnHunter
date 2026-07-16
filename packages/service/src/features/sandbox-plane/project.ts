/**
 * Projects SandboxPlane's raw profile shape into the minimal, capability-only
 * shape the Prepare extension is allowed to see (design v1.0 §5/§6):
 * profile_id + available + docker/kvm/qemu flags. No SandboxPlane address,
 * token, SSH, host, or image details ever cross this boundary.
 */
import type { SandboxPlaneRawProfile } from "./client.js";

export interface ProjectedSandboxType {
  profile_id: string;
  available: boolean;
  docker: boolean;
  kvm: boolean;
  qemu: boolean;
}

export function projectSandboxType(raw: SandboxPlaneRawProfile): ProjectedSandboxType {
  const caps = new Set(raw.capabilities);
  return {
    profile_id: raw.profile_id,
    available: raw.status === "available",
    docker: caps.has("docker"),
    kvm: caps.has("kvm"),
    qemu: caps.has("qemu_system"),
  };
}

export function projectSandboxTypes(raw: SandboxPlaneRawProfile[]): ProjectedSandboxType[] {
  return raw.map(projectSandboxType);
}
