import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["attribute", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brand: "#dc2626",
        "sev-high": "#ea580c",
        "sev-medium": "#ca8a04",
        "sev-low": "#2563eb",
        "sev-info": "#9ca3af",
      },
    },
  },
  plugins: [],
} satisfies Config;
