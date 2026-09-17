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
    testTimeout: 10000,
    // Clears BOARD_TASK_STORE/BOARD_DB_PATH inherited from the board service before any test
    // module loads, so the suite can never bind to the LIVE board database -- see the file's own
    // comment for the 2026-09-04 incident that made this necessary.
    setupFiles: ["test/setup/envIsolation.js"],
    // Fails the whole run if any test leaves the real repo's working tree dirtier than it found
    // it -- see test/globalSetup/workingTreeGuard.js (T-0302).
    globalSetup: ["test/globalSetup/workingTreeGuard.js"]
  }
});
