import { defineConfig, devices } from '@playwright/test';
import ordinary from './playwright.config';

// This is an explicit dev-only run, never a new production/scheduled slice.
// One worker and no retries bound TURN allocations and transferred bytes.
export default defineConfig(ordinary, {
  testMatch: /cloud-relay\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  webServer: undefined,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'relay-results.json' }]],
  use: { trace: 'off', video: 'off', screenshot: 'off' },
  projects: [
    { name: 'Relay Chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'Relay Firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'Relay WebKit', use: { ...devices['Desktop Safari'] } },
  ],
});
