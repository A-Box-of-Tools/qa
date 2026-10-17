import { test, expect } from '@playwright/test';
import { withoutThirdParties } from '../lib/engine';
import { pairedTools, hasOfflinePairing, offlineHooks, offlinePage, offlineIdle,
  noOfflineServers, networkHint, selectPairing } from '../lib/offline-pairing';

for (const tool of pairedTools) test.describe(`${tool}: shared offline pairing controls`, () => {
  test.beforeEach(() => test.skip(!hasOfflinePairing(tool), 'Full offline pairing is awaiting the website release.'));

  test('an offline first load creates no discovery, connection or capture and preserves explicit Offline', async ({ page }) => {
    await offlineHooks(page, true); await offlinePage(page, tool);
    await expect(page.locator('#pairing-auto')).toBeChecked();
    await expect(page.locator('#pairing-options')).not.toHaveAttribute('open');
    for (const method of ['auto', 'online', 'offline']) await expect(page.locator(`#pairing-${method}`)).toHaveAttribute('data-no-remember');
    await offlineIdle(page);
    await selectPairing(page, 'offline'); await networkHint(page, true);
    await expect(page.locator('#pairing-offline')).toBeChecked();
    await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
    await expect(page.locator('[data-pairing-nearby]')).toBeHidden(); await offlineIdle(page);
  });

  test('a manual draft survives a changed network hint without being submitted', async ({ page }) => {
    await offlineHooks(page, true); await offlinePage(page, tool);
    const draft = '{"unfinished":"offline pairing draft"}';
    await page.locator('#offline-offer-input').fill(draft); await networkHint(page, true);
    await expect(page.locator('#pairing-auto')).toBeChecked();
    await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
    await expect(page.locator('#offline-offer-input')).toHaveValue(draft);
    await expect(page.locator('#offline-answer')).toHaveValue(''); await offlineIdle(page);
  });

  test('an explicit Offline URL overrides an online hint before startup discovery', async ({ page }) => {
    await offlineHooks(page, true, true); await withoutThirdParties(page);
    await page.goto(`/${tool}/?pairing=offline`);
    await expect(page.locator('#pairing-offline')).toBeChecked();
    await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
    await expect(page.locator('[data-pairing-nearby]')).toBeHidden();
    await expect(page.locator('#offline-offer-input')).toBeVisible();
    await offlineIdle(page);
  });

  test('malformed and cross-tool offers create no peer, reply or permission prompt', async ({ page }) => {
    await offlineHooks(page, true); await offlinePage(page, tool);
    if (await page.locator('#viewer-name').isVisible()) await page.locator('#viewer-name').fill('Offline invalid-offer QA');
    const invalidPhrase = (await page.locator('[data-phrase="offline.invalid-offer"]').textContent())!.trim();
    const foreign = { format: `${tool === 'share-text' ? 'remote-camera' : 'share-text'}-offline-v1`,
      type: 'offer', session: 'a'.repeat(32), expires: Date.now() + 600_000,
      description: { type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' } };
    const prematureMedia = { ...foreign, format: `${tool}-offline-v1`,
      description: { type: 'offer', sdp: foreign.description.sdp + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } };
    for (const invalid of ['not-json', JSON.stringify(foreign), JSON.stringify(prematureMedia)]) {
      await page.locator('#offline-offer-input').fill(invalid);
      await page.locator('#offline-reply').click();
      await expect.poll(() => page.locator('[role="status"]').filter({ hasText: invalidPhrase })
        .evaluateAll(elements => elements.some(element => element.getClientRects().length > 0))).toBe(true);
      await expect(page.locator('#offline-answer')).toHaveValue('');
      await expect(page.locator('#offline-reply')).toBeEnabled();
      await offlineIdle(page);
    }
    await noOfflineServers(page);
  });
});
