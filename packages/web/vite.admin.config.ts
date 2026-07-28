import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:28080";

// Admin bundle — independent build, no shared chunk directory with business
export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_DOMAIN": JSON.stringify("admin"),
  },
  server: {
    port: 23001,
    host: "0.0.0.0",
    proxy: {
      "/api": API_TARGET,
    },
  },
  build: {
    outDir: "dist-admin",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "index-admin.html"),
    },
  },
});
