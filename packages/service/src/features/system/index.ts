export { systemRouter, adminSystemRouter } from "./routes.js";
export { initInstallation, getInstallationId } from "./installation.js";
export { resolveMachineIdentity } from "./machine-identity.js";
export type { MachineIdentity, MachineIdentitySource } from "./machine-identity.js";
export { setLicenseStatusGetter, getLicenseStatus } from "./license-status.js";
export type { CoreLicenseStatus } from "./license-status.js";
