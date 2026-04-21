import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:18080";
const WS_TARGET = API_TARGET.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": API_TARGET,
      "/ws": { target: WS_TARGET, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
