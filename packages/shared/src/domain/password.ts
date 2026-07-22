/**
 * Shared password rule for registration / reset / admin create.
 * ≥8 chars and must contain at least one letter and one digit.
 */
export function isStrongPassword(password: string): boolean {
  if (typeof password !== "string") return false;
  if (password.length < 8) return false;
  if (!/[A-Za-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

export const PASSWORD_RULE_MESSAGE =
  "Password must be at least 8 characters and include both letters and digits";
