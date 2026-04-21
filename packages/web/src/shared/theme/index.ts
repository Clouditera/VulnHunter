const STORAGE_KEY = "vh-theme";
type Theme = "light" | "dark";

const listeners: Array<() => void> = [];

function applyTheme(t: Theme): void {
  if (t === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function savedTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) ?? "light";
}

// Apply immediately (FOUC prevention — also done in index.html inline script)
applyTheme(savedTheme());

export const theme = {
  current(): Theme {
    return (document.documentElement.getAttribute("data-theme") as Theme) ?? "light";
  },

  set(t: Theme): void {
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
    listeners.forEach((fn) => fn());
  },

  toggle(): void {
    theme.set(theme.current() === "dark" ? "light" : "dark");
  },

  onChange(fn: () => void): () => void {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  },
};
