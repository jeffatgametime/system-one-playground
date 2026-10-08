import { defineConfig } from "@playwright/test";

const PORT = 8099;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: {
    // E2E must never inherit usable hosted credentials from a developer's .env.
    env: { TYPESAFE_API_KEY: "", OPENAI_API_KEY: "" },
    command: `LAB_RUN_DIR=$(mktemp -d -t lab-e2e) uv run --project ../gateway lab --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/system`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
