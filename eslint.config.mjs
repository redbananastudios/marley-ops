import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // React-Compiler advisory rule (eslint-plugin-react-hooks v6). It flags
      // the intentional "reset this dialog's form state when it opens" and
      // "setState('loading') then fetch" patterns used across ~14 dialogs.
      // These are correct, not bugs; refactoring every one on a live tool is
      // disproportionate risk for a perf hint, so we track it as a warning
      // rather than a build-blocking error. Fix opportunistically over time.
      "react-hooks/set-state-in-effect": "warn",
      // Allow intentionally-unused args/vars prefixed with _ (e.g. a required
      // signature param a function doesn't read).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone training-video pipeline — its own package.json + deps
    // (Remotion/Playwright), never part of the Next.js app. Lint it there.
    "training/**",
  ]),
]);

export default eslintConfig;
