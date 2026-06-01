import { getInstallationId } from "./installation.js";

export type CoreLicenseStatus = {
  status: "active" | "expired" | "not_activated" | "invalid";
  expires_at?: string;
  days_remaining?: number;
  machine_code: string;
  licensed_version?: string;
  invalid_reason?: string;
};

let getLicenseStatusImpl: () => Promise<CoreLicenseStatus> | CoreLicenseStatus = () => ({
  status: "active",
  machine_code: getInstallationId(),
});

export function setLicenseStatusGetter(getter: () => Promise<CoreLicenseStatus> | CoreLicenseStatus): void {
  getLicenseStatusImpl = getter;
}

export async function getLicenseStatus(): Promise<CoreLicenseStatus> {
  return getLicenseStatusImpl();
}
