import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    // reduce motion：跳過 boot 畫面與長動畫，測試穩定
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "rm -rf /tmp/lucy-e2e-data && VAULT_DATA_DIR=/tmp/lucy-e2e-data VAULT_LOGIN_RATE_MAX=100 BQ_DEMO=1 npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
