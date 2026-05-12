// Flat ESLint config (ESLint 9). Runs on the TypeScript sources only — the
// esbuild bundle (`.lambda-build/`) and the dist tsc output are ignored.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".lambda-build/**",
      "dist/**",
      "node_modules/**",
      "scripts/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The API throws and catches `unknown` errors all over the place; the
      // strict version of this rule produces too much noise without payoff
      // for this project size.
      "@typescript-eslint/no-explicit-any": "off",
      // We rely on `_arg` / `next` parameters in Express middleware that we
      // intentionally do not consume. Match them with the leading-underscore
      // convention instead of forcing eslint-disable comments.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
