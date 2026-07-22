/**
 * Shared password rule (contract A2): ≥8 chars, must contain letter AND digit.
 * Keep in lockstep with backend shared constant.
 */
export function isStrongPassword(password: string): boolean {
  if (password.length < 8) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

export function passwordRuleHint(locale: "zh" | "en" = "zh"): string {
  return locale === "zh"
    ? "至少 8 位，需同时包含字母和数字"
    : "At least 8 characters with letters and numbers";
}
