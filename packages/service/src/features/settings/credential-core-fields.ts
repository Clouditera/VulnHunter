/**
 * Core-field comparison for the credential edit gate (fish 2026-08-04):
 * edits that touch connectivity-defining fields must re-pass L1-L3
 * diagnostics before saving; optional-only edits (label, thinking_effort,
 * context_window, default flag) save directly.
 */

export interface CredentialCoreFields {
  proto_type: string;
  base_url?: string | null;
  model_id: string;
  api_key?: string;
}

const normalizeUrl = (v?: string | null): string => (v ?? "").replace(/\/+$/, "");

/** True when any core (connectivity) field differs. */
export function coreFieldsChanged(
  existing: CredentialCoreFields,
  input: CredentialCoreFields,
): boolean {
  if (input.proto_type !== existing.proto_type) return true;
  if (normalizeUrl(input.base_url) !== normalizeUrl(existing.base_url)) return true;
  if (input.model_id !== existing.model_id) return true;
  // Empty key on edit means "keep stored key" — unchanged by definition.
  if ((input.api_key ?? "") !== "" && input.api_key !== existing.api_key) return true;
  return false;
}

/** The key that will authenticate after save (input key, or stored when blank). */
export function effectiveApiKey(
  existing: CredentialCoreFields,
  input: CredentialCoreFields,
): string {
  return (input.api_key ?? "") !== "" ? input.api_key! : (existing.api_key ?? "");
}
