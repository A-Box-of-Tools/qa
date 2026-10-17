import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './experiments',
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.BASE_URL || 'https://pr-594.abox-preview.pages.dev/' },
  projects: [
    { name: 'Linux Chromium native', use: { browserName: 'chromium' } },
    { name: 'Linux WebKit native', use: { browserName: 'webkit' } },
  ],
});
