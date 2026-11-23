import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
const channel =
  process.env.PLAYWRIGHT_CHANNEL ??
  (process.platform === "win32" &&
  existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
    ? "chrome"
    : undefined);
export default defineConfig({
  testDir: "tests/e2e",
  testIgnore: ["**/mobile-app.spec.ts", "**/mobile-features.spec.ts"],
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    channel,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1080 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
});
