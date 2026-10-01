import { defineConfig, devices } from "@playwright/test";

// Browsers come from nixpkgs via PLAYWRIGHT_BROWSERS_PATH; @playwright/test is
// pinned to the matching playwright-driver version. Never `playwright install`.
export const E2E_PORT = 4791;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
