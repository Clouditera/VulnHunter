export type LicenseStatus = "active" | "expired" | "not_activated" | "invalid";

export interface SystemStatus {
  license: {
    status: LicenseStatus;
    expires_at?: string;
    days_remaining?: number;
    machine_code: string;
  };
  has_admin: boolean;
  is_authenticated: boolean;
  installation_id: string;
  user?: {
    id: string;
    email: string;
    role: "admin" | "member";
  } | null;
}
