import { logger } from "../../infra/logger.js";
import { resolveMachineIdentity } from "./machine-identity.js";

let installationId = "";

export function initInstallation(dataDir: string): void {
  const identity = resolveMachineIdentity({ dataDir });
  installationId = identity.code;
  // Log only the resolution source — never the DMI UUID or the machine code input.
  logger.info({ source: identity.source }, "Installation identity resolved");
}

export function getInstallationId(): string {
  return installationId;
}
