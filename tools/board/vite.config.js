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
    // Deliberately does not match test/browser/**/*.spec.js -- the Playwright suite (see
    // playwright.config.js) is separate on purpose (docs/browser-tests.md): `npm test` stays
    // the fast happy-dom/node default, `npm run test:browser` is the real-layout suite.
    include: ["test/**/*.test.js"],
    exclude: ["test/browser/**", "node_modules/**"],
    testTimeout: 10000
  }
});
