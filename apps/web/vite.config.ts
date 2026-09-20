import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@draft-royale/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) } },
  server: { proxy: { "/api": "http://localhost:4141" } },
  preview: { proxy: { "/api": "http://localhost:4141" } },
});
