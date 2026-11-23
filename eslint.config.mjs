import next from "@next/eslint-plugin-next";
import hooks from "eslint-plugin-react-hooks";
import ts from "typescript-eslint";
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/generated/**",
      ".local/**",
      ".tmp/**",
      "test-results/**",
      "playwright-report/**",
      "apps/web/next-env.d.ts",
    ],
  },
  ...ts.configs.recommended,
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "apps/web/" } },
    plugins: { "@next/next": next, "react-hooks": hooks },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      ...hooks.configs.recommended.rules,
    },
  },
  {
    files: ["apps/mobile/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: { ...hooks.configs.recommended.rules },
  },
  {
    files: ["apps/api/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
];
