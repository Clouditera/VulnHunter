/**
 * Core-field comparison for the credential edit gate (fish 2026-08-04, +
 * thinking_effort 2026-08-06): edits that touch connectivity-defining OR
 * model-behavior fields must re-pass diagnostics before saving;
 * optional-only edits (label, context_window, default flag) save directly.
 * thinking_effort changes the reasoning parameters sent to the model —
 * fish: it must require a fresh test like the identity fields.
 */

export interface CredentialCoreFields {
  proto_type: string;
  base_url?: string | null;
  model_id: string;
  api_key?: string;
  thinking_effort?: string;
}

const normalizeUrl = (v?: string | null): string => (v ?? "").replace(/\/+$/, "");

/** True when any core (connectivity / model-behavior) field differs. */
export function coreFieldsChanged(
  existing: CredentialCoreFields,
  input: CredentialCoreFields,
): boolean {
  if (input.proto_type !== existing.proto_type) return true;
  if (normalizeUrl(input.base_url) !== normalizeUrl(existing.base_url)) return true;
  if (input.model_id !== existing.model_id) return true;
  // Empty key on edit means "keep stored key" — unchanged by definition.
  if ((input.api_key ?? "") !== "" && input.api_key !== existing.api_key) return true;
  if ((input.thinking_effort ?? "") !== (existing.thinking_effort ?? "")) return true;
  return false;
}

/** The key that will authenticate after save (input key, or stored when blank). */
export function effectiveApiKey(
  existing: CredentialCoreFields,
  input: CredentialCoreFields,
): string {
  return (input.api_key ?? "") !== "" ? input.api_key! : (existing.api_key ?? "");
}
