import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.VITE_API_TARGET ?? "http://localhost:28080";
const WS_TARGET = API_TARGET.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    port: 23000,
    host: "0.0.0.0",
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
