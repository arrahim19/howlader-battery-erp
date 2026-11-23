import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const url = process.env.MOBILE_PREVIEW_URL ?? "http://localhost:8081";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: [
    "mobile-app.spec.ts",
    "mobile-features.spec.ts",
    "mobile-session.spec.ts",
  ],
  outputDir: "test-results/mobile-app",
  workers: 1,
  timeout: 120000,
  reporter: "list",
  use: {
    ...devices["Pixel 7"],
    defaultBrowserType: "chromium",
    channel:
      process.env.PLAYWRIGHT_CHANNEL ??
      (process.platform === "win32" &&
      existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
        ? "chrome"
        : undefined),
    trace: "retain-on-failure",
  },
  webServer: process.env.MOBILE_PREVIEW_URL
    ? undefined
    : {
        command: "npm run web --workspace @hawlader/mobile -- --port 8081",
        url,
        reuseExistingServer: !process.env.CI,
        timeout: 180000,
        env: { BROWSER: "none" },
      },
});
