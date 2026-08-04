/**
 * Lightweight i18n — vanilla JS approach, no external library.
 * Key naming: nav.dashboard, tasks.status.running, etc.
 */
import { ZH } from "./zh.js";
import { EN } from "./en.js";


const CATALOGS: Record<string, Record<string, string>> = { zh: ZH, en: EN };

const STORAGE_KEY = "va-lang";

function detectLocale(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  return "zh";
}

let currentLocale = detectLocale();
const listeners: Array<() => void> = [];

export const i18n = {
  t(key: string): string {
    return CATALOGS[currentLocale]?.[key] ?? CATALOGS.en[key] ?? key;
  },

  locale(): string {
    return currentLocale;
  },

  setLocale(lang: "zh" | "en"): void {
    currentLocale = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    listeners.forEach((fn) => fn());
  },

  toggle(): void {
    i18n.setLocale(currentLocale === "zh" ? "en" : "zh");
  },

  onChange(fn: () => void): () => void {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },

  /** Merge extra catalog keys (admin bundle registers admin.* here). */
  register(locale: "zh" | "en", entries: Record<string, string>): void {
    CATALOGS[locale] = { ...CATALOGS[locale], ...entries };
  },
};
