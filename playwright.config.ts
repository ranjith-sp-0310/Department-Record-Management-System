import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// When CHECKLY=1, tests run inside Checkly infrastructure against the public URL.
// When unset, tests run locally against the Vite dev server.
const isCheckly = !!process.env.CHECKLY;

export default defineConfig({
  testDir: './tests',

  // Fail fast locally; Checkly retries handle transient failures in monitoring.
  retries: isCheckly ? 2 : 0,

  use: {
    // Full traces on every Checkly run for easy post-mortem debugging.
    // Locally, only keep traces when a test fails.
    trace: isCheckly ? 'on' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // ── Checkly monitoring project ─────────────────────────────────────────
    // Referenced by pwProjects: ['checkly'] in checkly.config.ts.
    // Uses the deployed public URL; no local webServer is needed.
    {
      name: 'checkly',
      use: {
        ...devices['Desktop Chrome'],
        baseURL:
          process.env.PUBLIC_MONITOR_URL || 'https://staging.example.com',
      },
    },

    // ── Local development project ──────────────────────────────────────────
    // Used when running `npx playwright test` locally (no CHECKLY env var).
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3000',
      },
    },
  ],

  // Start the Vite dev server automatically for local runs.
  // Disabled in Checkly: the public URL is used instead.
  webServer: isCheckly
    ? undefined
    : {
        command: 'npm run dev',
        cwd: path.join(__dirname, 'frontend'),
        url: 'http://localhost:3000',
        // Reuse an already-running Vite server (speeds up local iteration).
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
