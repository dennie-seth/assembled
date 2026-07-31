import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist"
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.js"],
    testTimeout: 10000
  }
});
