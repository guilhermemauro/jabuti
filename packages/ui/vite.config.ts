import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same origin as in production: the server checks Origin against Host (C15).
    proxy: {
      "/ws": { target: "ws://127.0.0.1:4317", ws: true },
      "/api": { target: "http://127.0.0.1:4317" },
    },
  },
});
