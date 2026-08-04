/** SaaS-facing support contact (never show on community/enterprise). */
export const SUPPORT_EMAIL = "support@vulnhunter.pro";

export function supportMailto(subject?: string): string {
  const q = subject ? `?subject=${encodeURIComponent(subject)}` : "";
  return `mailto:${SUPPORT_EMAIL}${q}`;
}
