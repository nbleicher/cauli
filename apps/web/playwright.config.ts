import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // These integration scenarios share one local Supabase workspace and one
  // Next.js development server. Match CI's single-worker execution so cold
  // compilation and hydration do not become machine-dependent test inputs.
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:3102",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3102",
    url: "http://127.0.0.1:3102/api/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
