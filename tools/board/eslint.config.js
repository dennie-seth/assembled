import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

// T-0404: a bare `fs.rm(dir, { recursive: true, force: true })` (or the same call via a
// destructured `import { rm } from "node:fs/promises"`) teardown races git's own background
// writes (`gc --auto`, index-lock release) into a temp/worktree dir and flakes with ENOTEMPTY --
// see test/helpers/rmTemp.js. Matches both callee shapes (`fs.rm(...)` and bare `rm(...)`) and
// `rmSync` too, regardless of `recursive`/`force` property order. Exported so
// test/lint/tempTeardownGuard.test.js lints against this exact rule object instead of a
// hand-copied duplicate that could drift from it.
export const noBareTempTeardownRule = {
  selector:
    "CallExpression:matches([callee.name=/^rm(Sync)?$/], [callee.property.name=/^rm(Sync)?$/]) > ObjectExpression:has(Property[key.name='recursive'][value.value=true]):has(Property[key.name='force'][value.value=true])",
  message:
    "Use rmTemp(dir) from test/helpers/rmTemp.js instead of a bare rm(dir, { recursive: true, force: true }) teardown -- see its docstring for the ENOTEMPTY race this avoids."
};

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
    files: ["test/**/*.js"],
    rules: {
      "no-restricted-syntax": ["error", noBareTempTeardownRule]
    }
  },
  {
    // The helper itself is the one place allowed to do the raw fs.rm(..., { recursive, force }) call.
    files: ["test/helpers/rmTemp.js"],
    rules: {
      "no-restricted-syntax": "off"
    }
  },
  {
    ignores: ["dist/**", "node_modules/**"]
  }
];
