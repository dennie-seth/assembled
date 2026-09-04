import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    // test/browser/**: Playwright specs run browser code inside page.evaluate() callbacks, so they
    // legitimately reference document/window even though the file itself executes in node.
    files: ["src/client/**/*.js", "test/client/**/*.js", "test/browser/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser
      }
    }
  },
  {
    ignores: ["dist/**", "node_modules/**"]
  }
];
