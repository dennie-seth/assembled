import { defineConfig } from "@playwright/test";

// A distinct port from the live dev server (4173, see vite.config.js's BOARD_PORT default) so
// `npm run test:browser` never collides with a board instance a developer/agent already has
// running locally.
const PORT = 4310;

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.spec.js",
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  // Probes whether Chromium can actually launch (not just whether the binary file exists)
  // before any spec runs, so an unlaunchable browser skips cleanly instead of every test
  // failing individually -- see test/browser/support/globalSetup.js.
  globalSetup: "./test/browser/support/globalSetup.js",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1000, height: 800 }
  },
  // Serves the fixture pages via the same Vite dev server the real app uses -- no bespoke static
  // server, and `renderBoard`'s ESM import resolves exactly as it does for `npm run dev:client`.
  // Bound to 127.0.0.1 only, per this repo's network-binding rule (CLAUDE.md); no `/api`/`/ws`
  // route the fixtures load ever gets a real request, so this stays a "no network" harness.
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
