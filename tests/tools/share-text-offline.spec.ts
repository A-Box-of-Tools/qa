import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { BASE_URL } from '../../lib/site';
import { hasOfflinePairing, offlineHooks, offlinePage, readOfflineOffer, createOfflineReply,
  acceptOfflineReply, freshOfflineOffer, nativeOfflineOnly, offlinePeersClosed, noOfflineServers,
  networkHint, offlinePeerSnapshot } from '../../lib/offline-pairing';

const secret = 'Offline private text: exact bytes — 日本語\nSecond line 0123456789';

async function prepare(page: Page) {
  await offlineHooks(page, true); await offlinePage(page, 'share-text');
}

async function consentAndAsk(reader: Page, host: Page, name: string) {
  await expect(reader.locator('#consent')).toBeVisible({ timeout: 20_000 });
  await expect(reader.locator('#panel')).not.toContainText(secret);
  await expect(reader.locator('#filelist .filerow')).toHaveCount(0);
  await reader.locator('#connect').click();
  await expect(reader.locator('#knockrow')).toBeVisible({ timeout: 20_000 });
  await reader.locator('#knock').fill(name); await reader.locator('#send-knock').click();
  await expect(host.locator('#requests')).toContainText(name, { timeout: 20_000 });
  await expect(reader.locator('#panel')).not.toContainText(secret);
  await expect(reader.locator('#filelist .filerow')).toHaveCount(0);
}

test.describe('share-text: native offline pairing', () => {
  test.beforeEach(() => {
    test.skip(!hasOfflinePairing('share-text'), 'Full offline text pairing is awaiting the website release.');
    test.setTimeout(150_000);
  });

  test('two private readers need individual exchange, receive consent and admission before exact text and files', async ({ page, browser }) => {
    const firstContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    const secondContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      await prepare(page); const localBefore = await page.locator('#local').isChecked();
      await page.locator('#text').fill(secret); await page.locator('#private').check();
      await page.locator('#publish').click();
      const offer = await readOfflineOffer(page, 'share-text'); expect(offer).not.toContain(secret);
      const binary = Buffer.from(Array.from({ length: 130_000 }, (_, at) => (at * 29) % 256));
      const files = [{ name: 'offline-binary.bin', buffer: binary }, { name: 'offline-empty.bin', buffer: Buffer.alloc(0) }];
      await page.locator('#fileinput').setInputFiles(files.map(file => ({ ...file, mimeType: 'application/octet-stream' })));
      const first = await firstContext.newPage(); await prepare(first);
      // Only the offering device owns its expiry timestamp. The recipient's
      // wall clock may differ while both native peers can still communicate.
      await first.evaluate(() => { const clock = Date.now; Date.now = () => clock() + 3_600_000; });
      const answer = await createOfflineReply(first, 'share-text', offer); expect(answer).not.toContain(secret);
      await expect(page.locator('#requests button')).toHaveCount(0);
      await acceptOfflineReply(page, answer);
      try { await expect(first.locator('#consent')).toBeVisible({ timeout: 20_000 }); }
      catch (error) {
        await test.info().attach('offline-native-state', { contentType: 'application/json',
          body: JSON.stringify({ host: await offlinePeerSnapshot(page), reader: await offlinePeerSnapshot(first),
            hostStatus: await page.locator('#offline-accept-status').textContent(),
            readerStatus: await first.locator('#text-offline-status').textContent() }) });
        throw error;
      }
      await expect(page.locator('#requests button')).toHaveCount(0);
      await consentAndAsk(first, page, 'First offline reader');
      await page.locator('#requests button').first().click();
      await expect.poll(() => first.locator('#received').textContent(), { timeout: 20_000 }).toBe(secret);
      await expect(first.locator('#filelist .filerow')).toHaveCount(2);
      for (const file of files) {
        const row = first.locator('#filelist .filerow').filter({ hasText: file.name });
        const saved = first.waitForEvent('download'); await row.locator('[data-file-download]').click();
        const download = await saved;
        expect(download.suggestedFilename()).toBe(file.name);
        expect(await readFile((await download.path())!)).toEqual(file.buffer);
      }

      const next = await freshOfflineOffer(page, 'share-text', offer);
      const second = await secondContext.newPage(); await prepare(second);
      await acceptOfflineReply(page, await createOfflineReply(second, 'share-text', next));
      await consentAndAsk(second, page, 'Second offline reader');
      await expect.poll(() => first.locator('#received').textContent()).toBe(secret);
      await page.locator('#requests button').first().click();
      await expect.poll(() => second.locator('#received').textContent(), { timeout: 20_000 }).toBe(secret);
      const updated = `${secret}\nUpdated after both readers were admitted.`;
      await page.locator('#text').fill(updated);
      for (const reader of [first, second]) await expect.poll(() => reader.locator('#received').textContent()).toBe(updated);
      await networkHint(page, true);
      await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
      await expect(page.locator('#pairing-status')).toBeHidden();
      await nativeOfflineOnly(page, first, second); await networkHint(page, false);
      await page.locator('#stop').click(); await offlinePeersClosed(page, first, second);
      for (const reader of [first, second]) {
        await expect(reader.locator('#panel')).not.toContainText(secret);
        await expect(reader.locator('#filelist .filerow')).toHaveCount(0);
        expect(await reader.evaluate(() => (window as any).__offlineQA.captures)).toBe(0);
      }
      expect(await page.locator('#local').isChecked()).toBe(localBefore);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await noOfflineServers(page, first, second);
    } finally { await firstContext.close(); await secondContext.close(); }
  });

  test('a fresh reader exchange rejects retired and expired replies, and Stop cancels pending consent', async ({ page, context }) => {
    await prepare(page); await page.locator('#text').fill(secret);
    await page.locator('#publish').click();
    const offer = await readOfflineOffer(page, 'share-text');
    const reader = await context.newPage(); await prepare(reader);
    const oldAnswer = await createOfflineReply(reader, 'share-text', offer);
    await networkHint(reader, true);
    await expect(reader.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
    await networkHint(reader, false);
    const next = await freshOfflineOffer(page, 'share-text', offer);
    await acceptOfflineReply(page, oldAnswer);
    await expect(page.locator('#offline-accept-status')).toContainText(/match|invalid|another/i);
    await expect(page.locator('#requests button')).toHaveCount(0);
    await expect(reader.locator('#panel')).not.toContainText(secret);
    await reader.locator('#text-offline-stop').click(); await offlinePeersClosed(reader);
    const fresh = await context.newPage(); await prepare(fresh);
    const answer = await createOfflineReply(fresh, 'share-text', next);
    await page.evaluate(expires => { Date.now = () => expires + 1; }, JSON.parse(next).expires);
    await acceptOfflineReply(page, answer);
    await expect(page.locator('#offline-accept-status')).toContainText(/expired/i);
    await expect(page.locator('#requests button')).toHaveCount(0);
    await page.locator('#stop').click(); await fresh.locator('#text-offline-stop').click();
    await offlinePeersClosed(page, reader, fresh);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await noOfflineServers(page, reader, fresh);
  });
});
