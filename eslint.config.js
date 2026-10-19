// ESLint: catches common mistakes in the server, tests and page script.
// Run with `npm run lint` (CI runs it on every push and pull request).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules/**", "data/**", "bin/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["server/**/*.ts", "test/**/*.ts", "scripts/**/*.{ts,mjs,js}", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    // Server logs go through deliberate, commented console calls only.
    files: ["server/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
