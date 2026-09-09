// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Deliberately close to the recommended baseline rather than a large
 * house style: the codebase is already internally consistent, and a
 * linter that flags hundreds of pre-existing lines on day one just gets
 * ignored. The rules that ARE customized below are the ones that would
 * otherwise fight patterns this project uses on purpose.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "scripts/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_event` is the conventional name for an unused Electron IPC
      // first argument, which appears in nearly every handler.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Settings migration reads files written by older versions, whose
      // shape genuinely isn't known ahead of time — see settingsSchema.
      "@typescript-eslint/no-explicit-any": "off",
      // A bare `catch {}` after a failed best-effort cleanup is a
      // deliberate, commented pattern here, not an oversight.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Renderer code runs in the browser context, not Node.
    files: ["src/ui/**/*.ts"],
    languageOptions: { globals: { window: "readonly", document: "readonly", console: "readonly" } },
    rules: {
      // Each renderer declares `interface Window { nimbus: NimbusApi }` to
      // type the preload bridge. That augments the DOM's own Window, so
      // it has no local reference for the rule to find — it is used by
      // every `window.nimbus.*` call in the file.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^(_|Window$)", caughtErrors: "none" },
      ],
    },
  }
);
