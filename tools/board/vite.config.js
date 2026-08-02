import { defineConfig } from "vite";

const BACKEND_URL = `http://127.0.0.1:${Number(process.env.BOARD_PORT) || 4173}`;

export default defineConfig({
  build: {
    outDir: "dist"
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": BACKEND_URL,
      "/ws": {
        target: BACKEND_URL,
        ws: true
      }
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    testTimeout: 10000
  }
});
