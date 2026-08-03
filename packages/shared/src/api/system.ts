export type LicenseStatus = "active" | "expired" | "not_activated" | "invalid";

export type Edition = "community" | "enterprise" | "saas";

export interface SystemStatus {
  edition: Edition;
  license: {
    status: LicenseStatus;
    expires_at?: string;
    days_remaining?: number;
    machine_code: string;
    licensed_version?: string;
    invalid_reason?: string;
  };
  version: {
    product: string;
    version: string;
    buildTime?: string;
    gitCommit?: string;
    youngflowVersion?: string;
    licenseSchema: string;
  };
  has_admin: boolean;
  is_authenticated: boolean;
  installation_id: string;
  user?: {
    id: string;
    email: string;
    role: "admin" | "member";
    displayName: string;
    task_limit?: number;
    task_count?: number;
    onboarding_dismissed?: boolean;
  } | null;
}
