import { test } from '@playwright/test';
import { runLocalShareJourney } from '../../lib/share-text-local-network';

test('share-text: Local network mode connects separate Chrome processes and delivers approved content',
  async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome',
      'this case exercises separate native Chromium processes; physical PC/browser coverage has its own checklist');
    test.setTimeout(150_000);
    // A separate process crosses browser networking state while still using
    // the runner's one LAN. Both contexts belong to the shared journey.
    const readerBrowser = await browser.browserType().launch();
    try {
      await runLocalShareJourney({ sharerBrowser: browser, readerBrowser }, testInfo);
    } finally {
      await readerBrowser.close().catch(() => {});
    }
  });
