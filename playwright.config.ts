import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { BASE_URL, ETOOLBOX_DIR, PORT } from './lib/site';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Four in CI because that is what a public-repo ubuntu runner actually has
  // - four vCPUs. The old cap of two was sized from watching QR tests fail
  // under eight workers on a local machine, which was the wrong evidence to
  // size a different machine by.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Same specs, two Chromes: a real desktop viewport/UA and a real mobile one
  // (touch, device pixel ratio, narrow viewport, mobile UA). That is what
  // catches a layout that only breaks at one of the two.
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],

  // Builds and serves ETOOLBOX_DIR with its own scripts (python build.py,
  // then serve.ps1) so what the tests see is exactly what would deploy.
  // Skipped entirely when BASE_URL is set, so pointing this suite at a
  // server you already started - or the live site - never triggers a
  // second build alongside it.
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `powershell -ExecutionPolicy Bypass -File "${path.join(ETOOLBOX_DIR, 'serve.ps1')}" -Port ${PORT}`,
        cwd: ETOOLBOX_DIR,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        // etoolbox's own build.py has been observed taking anywhere from
        // ~3 to 7+ minutes on a cold run (eleven locales, ~30 tools),
        // apparently load-dependent on this machine; give it real headroom
        // rather than a timeout tuned to a fast, idle one.
        timeout: 600_000,
        env: {
          ...process.env,
          // build.py prints translated page paths (Arabic slugs included) to
          // stdout. Piped through a non-interactive process on a Windows
          // console whose codepage isn't UTF-8 (e.g. GBK), that print raises
          // UnicodeEncodeError, build.py exits non-zero, and serve.ps1 reads
          // that as "build failed" and never starts the listener - so the
          // whole webServer looks like a timeout with no clue why. Forcing
          // UTF-8 I/O here fixes it without touching etoolbox's own source.
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      },
});
