/** VulnHunt License Certificate format */

export interface LicenseBasic {
  type: string;           // "time" | "count" | ...
  machine_code: string;   // installation_id UUID
  software: string;       // "vulnhunt"
  version: string;        // "1.0"
  expire_at: number;      // Unix timestamp (seconds)
  subject: string;        // customer name
  issuer: string;         // "Clouditera"
  auth_at: number;        // Unix timestamp (seconds)
  biz: string;            // JSON string: {"enabled": true}
}

export interface LicenseCert {
  Basic: LicenseBasic;
  Ver: string;            // "1"
  Sig: string;            // base64-encoded RSA-2048 + SHA256 signature of JSON(Basic)
}

export type LicenseStatus = "active" | "expired" | "not_activated" | "invalid";

export interface LicenseState {
  status: LicenseStatus;
  expiresAt?: Date;
  daysRemaining?: number;
  machineCode: string;
}
