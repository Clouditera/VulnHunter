import { i18n } from "../i18n/index.js";

/**
 * Format a datetime for display, locale-aware.
 * zh: "2026-04-21 16:18"
 * en: "Apr 21, 2026 16:18"
 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  const lang = i18n.locale();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  if (lang === "zh") return `${y}-${m}-${day} ${hh}:${mm}`;
  const monthName = d.toLocaleString("en-US", { month: "short" });
  return `${monthName} ${d.getDate()}, ${y} ${hh}:${mm}`;
}

/**
 * Relative "N min ago / N hours ago / yesterday" style. Used for dashboard recent scans.
 */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  const lang = i18n.locale();
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return lang === "zh" ? "刚刚" : "just now";
  if (min < 60) return lang === "zh" ? `${min} 分钟前` : `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return lang === "zh" ? `${hr} 小时前` : `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return lang === "zh" ? "昨天" : "yesterday";
  if (day < 7) return lang === "zh" ? `${day} 天前` : `${day} days ago`;
  return formatDateTime(d);
}

