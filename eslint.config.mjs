import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

// Next 16 removed the `next lint` command, so ESLint runs through its own CLI
// against this flat config. `core-web-vitals` already includes the base Next
// config; `typescript` layers typescript-eslint's recommended rules on top.
const config = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // The codebase already marks deliberately-unused bindings with a leading
      // underscore (destructured props that exist only to be dropped from a
      // spread, for instance). Teach the rule that convention rather than
      // leaving warnings that `--max-warnings 0` would fail on.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
];

export default config;
