import { test, expect, type Page } from '@playwright/test';
import { hasOfflinePairing, offlineHooks, offlinePage, readOfflineOffer, createOfflineReply,
  acceptOfflineReply, freshOfflineOffer, nativeOfflineOnly, offlinePeersClosed, noOfflineServers,
  networkHint, type PairedTool } from '../../lib/offline-pairing';
import { voiceHooks, receivedAudio, outputRms, tracksStopped, microphoneEnabled, installVoiceLifecycle } from '../../lib/voice-fixtures';

async function prepareVoice(page: Page, tool: PairedTool, capture: 'allow' | 'deny') {
  await voiceHooks(page, capture); await offlineHooks(page); await offlinePage(page, tool);
}

async function audioArrives(page: Page, webAudio = false) {
  const before = await receivedAudio(page);
  await expect.poll(async () => (await receivedAudio(page)).packets, { timeout: 20_000 }).toBeGreaterThan(before.packets + 5);
  if (webAudio) await expect.poll(() => outputRms(page), { timeout: 20_000 }).toBeGreaterThan(0.01);
  else await expect.poll(async () => (await receivedAudio(page)).energy, { timeout: 20_000 }).toBeGreaterThan(before.energy);
}

async function quietAfterInterruption(page: Page, toggle: string) {
  await installVoiceLifecycle(page);
  await page.evaluate(() => (window as any).__voiceLifecycle.setHidden(true));
  expect(await microphoneEnabled(page)).toBe(true);
  await page.evaluate(() => {
    (window as any).__voiceLifecycle.setHidden(false);
    (window as any).__voiceLifecycle.interrupt('mute');
  });
  await expect.poll(() => microphoneEnabled(page)).toBe(false);
  await page.evaluate(() => {
    (window as any).__voiceLifecycle.setHidden(true);
    (window as any).__voiceLifecycle.setHidden(false);
    (window as any).__voiceLifecycle.interrupt('unmute');
  });
  await expect(page.locator(toggle)).toHaveAttribute('aria-pressed', 'false');
  expect(await microphoneEnabled(page)).toBe(false);
}

test('walkie-talkie: offline exchange reaches two receive-only listeners, keeps talking deliberate, and End is final', async ({ page, context, browserName }) => {
  test.skip(!hasOfflinePairing('walkie-talkie'), 'Full offline voice pairing is awaiting the website release.');
  test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; offline controls also run in WebKit.');
  test.setTimeout(120_000);
  await prepareVoice(page, 'walkie-talkie', 'allow');
  await page.locator('#wt-room-name').fill('Offline QA channel'); await page.locator('#wt-start').click();
  const offer = await readOfflineOffer(page, 'walkie-talkie');
  expect(await microphoneEnabled(page)).toBe(false);
  const first = await context.newPage(); await prepareVoice(first, 'walkie-talkie', 'deny');
  await acceptOfflineReply(page, await createOfflineReply(first, 'walkie-talkie', offer));
  await expect(first.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
  expect(await first.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  const next = await freshOfflineOffer(page, 'walkie-talkie', offer);
  const second = await context.newPage(); await prepareVoice(second, 'walkie-talkie', 'deny');
  await acceptOfflineReply(page, await createOfflineReply(second, 'walkie-talkie', next));
  await expect(second.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
  await expect(page.locator('#wt-listener-count')).toContainText('2');
  expect(await microphoneEnabled(page)).toBe(false);
  await networkHint(page, true);
  await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
  await expect(page.locator('#pairing-status')).toBeHidden();
  await page.locator('#wt-toggle').click(); await expect.poll(() => microphoneEnabled(page)).toBe(true);
  await audioArrives(first); await audioArrives(second);
  await quietAfterInterruption(page, '#wt-toggle');
  for (const listener of [first, second]) {
    expect(await listener.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    expect(await listener.evaluate(() => (window as any).__voiceQA.peers.every((peer: RTCPeerConnection) => peer.getSenders().every(sender => !sender.track)))).toBe(true);
  }
  await nativeOfflineOnly(page, first, second); await networkHint(page, false);
  await page.locator('#wt-end').click(); await tracksStopped(page); await offlinePeersClosed(page, first, second);
  for (const listener of [first, second]) await expect(listener.locator('#wt-status-text')).toHaveText('The host ended this broadcast.');
  const calls = await page.evaluate(() => (window as any).__voiceQA.calls.length);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(calls);
  await noOfflineServers(page, first, second);
});

test('voice-oncall: Cancel after password refusal and Disconnect during capture retire the whole offline attempt', async ({ page, context, browserName }) => {
  test.skip(!hasOfflinePairing('voice-oncall'), 'Full offline voice pairing is awaiting the website release.');
  test.skip(browserName !== 'chromium', 'Native microphone cleanup runs in Chromium; offline controls also run in WebKit.');
  test.setTimeout(120_000);
  const password = 'QA-offline-cancel-password';
  await prepareVoice(page, 'voice-oncall', 'deny'); await page.locator('#vi-tab-host').click();
  await page.locator('#vi-room-name').fill('Offline cancel QA'); await page.locator('#vi-password-required').check();
  await page.locator('#vi-host-password').fill(password); await page.locator('#vi-start').click();
  const offer = await readOfflineOffer(page, 'voice-oncall');
  const caller = await context.newPage(); await prepareVoice(caller, 'voice-oncall', 'allow');
  await acceptOfflineReply(page, await createOfflineReply(caller, 'voice-oncall', offer));
  await expect(caller.locator('#vi-join')).toBeEnabled({ timeout: 20_000 });
  await caller.locator('#vi-sender-password').fill('wrong-password'); await caller.locator('#vi-join').click();
  await expect(caller.locator('#vi-status-text')).toContainText('That password did not match');
  await caller.locator('#vi-offline-cancel').click(); await tracksStopped(caller); await offlinePeersClosed(caller);
  for (const selector of ['#vi-tab-host', '#vi-tab-join', '#vi-start', '#offline-reply']) await expect(caller.locator(selector)).toBeEnabled();
  await expect(caller.locator('#vi-offline-cancel')).toBeHidden();
  await expect(caller.locator('#vi-leave')).toBeHidden();
  await expect(page.locator('#vi-participants > li')).toHaveCount(0);

  const next = await freshOfflineOffer(page, 'voice-oncall', offer);
  await acceptOfflineReply(page, await createOfflineReply(caller, 'voice-oncall', next));
  await expect(caller.locator('#vi-join')).toBeEnabled({ timeout: 20_000 });
  await caller.evaluate(() => {
    const media = navigator.mediaDevices, capture = media.getUserMedia.bind(media);
    const pending = (window as any).__offlineCapture = { release: null as null | (() => void) };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: new Proxy(media, {
      get(target, property) {
        if (property === 'getUserMedia') return async (constraints: MediaStreamConstraints) => {
          const stream = await capture(constraints);
          return new Promise<MediaStream>(resolve => { pending.release = () => resolve(stream); });
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) });
  });
  await caller.locator('#vi-sender-password').fill(password); await caller.locator('#vi-join').click();
  await expect.poll(() => caller.evaluate(() => typeof (window as any).__offlineCapture.release)).toBe('function');
  await expect(caller.locator('#pairing-auto')).toBeDisabled();
  await caller.locator('#vi-leave').click();
  await caller.evaluate(() => (window as any).__offlineCapture.release());
  await tracksStopped(caller); await offlinePeersClosed(caller);
  await expect(caller.locator('#vi-tab-host')).toBeEnabled(); await expect(caller.locator('#vi-start')).toBeEnabled();
  await expect(caller.locator('#vi-leave')).toBeHidden();
  await expect(page.locator('#vi-participants > li')).toHaveCount(0);
  const calls = await caller.evaluate(() => (window as any).__voiceQA.calls.length);
  await caller.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  expect(await caller.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(calls);
  await page.locator('#vi-end').click(); await offlinePeersClosed(page, caller); await noOfflineServers(page, caller);
});

test('voice-oncall: offline password, quiet Connect and moderation work for independently paired callers', async ({ page, context, browserName }) => {
  test.skip(!hasOfflinePairing('voice-oncall'), 'Full offline voice pairing is awaiting the website release.');
  test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; offline controls also run in WebKit.');
  test.setTimeout(150_000);
  const password = 'QA-offline-pager-secret';
  await prepareVoice(page, 'voice-oncall', 'deny'); await page.locator('#vi-tab-host').click();
  await page.locator('#vi-room-name').fill('Offline QA pager'); await page.locator('#vi-password-required').check();
  await page.locator('#vi-host-password').fill(password); await page.locator('#vi-start').click();
  const offer = await readOfflineOffer(page, 'voice-oncall'); expect(offer).not.toContain(password);
  const first = await context.newPage(); await prepareVoice(first, 'voice-oncall', 'allow');
  const reply = await createOfflineReply(first, 'voice-oncall', offer);
  expect(reply).not.toContain(password);
  expect(await first.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  await acceptOfflineReply(page, reply);
  await expect(first.locator('#vi-join')).toBeEnabled({ timeout: 20_000 });
  expect(await first.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  await first.locator('#vi-sender-password').fill('wrong-offline-password'); await first.locator('#vi-join').click();
  await expect(first.locator('#vi-status-text')).toContainText('That password did not match', { timeout: 20_000 });
  await expect(page.locator('#vi-participants > li')).toHaveCount(0);
  expect(await microphoneEnabled(first)).toBe(false);
  await first.locator('#vi-sender-password').fill(password); await first.locator('#vi-join').click();
  await expect(first.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.', { timeout: 20_000 });
  expect(await microphoneEnabled(first)).toBe(false);
  await expect(page.locator('#vi-participants .vi-participant-name')).toHaveText(/^Caller /);
  const firstName = await page.locator('#vi-participants .vi-participant-name').innerText();

  const next = await freshOfflineOffer(page, 'voice-oncall', offer);
  const second = await context.newPage(); await prepareVoice(second, 'voice-oncall', 'allow');
  await acceptOfflineReply(page, await createOfflineReply(second, 'voice-oncall', next));
  await expect(second.locator('#vi-join')).toBeEnabled({ timeout: 20_000 });
  expect(await second.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  await second.locator('#vi-sender-password').fill(password); await second.locator('#vi-join').click();
  await expect(second.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.', { timeout: 20_000 });
  await expect(page.locator('#vi-participants > li')).toHaveCount(2);
  expect(await microphoneEnabled(second)).toBe(false);
  expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  await first.locator('#vi-toggle').click(); await audioArrives(page, true);
  await quietAfterInterruption(first, '#vi-toggle');
  await page.getByRole('button', { name: `Mute ${firstName}`, exact: true }).click();
  await expect(first.locator('#vi-status-text')).toContainText('The host muted you');
  await expect(first.locator('#vi-hold')).toBeDisabled(); expect(await microphoneEnabled(first)).toBe(false);
  await page.getByRole('button', { name: `Unmute ${firstName}`, exact: true }).click();
  await expect(first.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.');
  expect(await microphoneEnabled(first)).toBe(false);
  await page.getByRole('button', { name: `Remove ${firstName}`, exact: true }).click();
  await expect(first.locator('#vi-status-text')).toContainText('The host removed you'); await tracksStopped(first);
  await expect(page.locator('#vi-participants > li')).toHaveCount(1);
  await second.locator('#vi-toggle').click(); await audioArrives(page, true);
  await nativeOfflineOnly(page, first, second);
  await page.locator('#vi-end').click(); await tracksStopped(second); await offlinePeersClosed(page, first, second);
  await expect.poll(async () => (await second.locator('#vi-status-text, #vi-offline-status').allTextContents()).join(' '))
    .toMatch(/host ended this pager|direct connection closed/i);
  await noOfflineServers(page, first, second);
});

for (const tool of ['walkie-talkie', 'voice-oncall'] as const) test(`${tool}: replaced and expired offline replies cannot admit a client or revive End`, async ({ page, context, browserName }) => {
  test.skip(!hasOfflinePairing(tool), 'Full offline voice pairing is awaiting the website release.');
  test.skip(browserName !== 'chromium', 'Native audio setup runs in Chromium; malformed offers also run in WebKit.');
  test.setTimeout(90_000);
  const walkie = tool === 'walkie-talkie', prefix = walkie ? 'wt' : 'vi';
  await prepareVoice(page, tool, walkie ? 'allow' : 'deny');
  if (!walkie) await page.locator('#vi-tab-host').click();
  await page.locator(`#${prefix}-room-name`).fill('Offline retired voice invitation'); await page.locator(`#${prefix}-start`).click();
  const offer = await readOfflineOffer(page, tool);
  const client = await context.newPage(); await prepareVoice(client, tool, 'deny');
  const reply = await createOfflineReply(client, tool, offer);
  await networkHint(client, true);
  await expect(client.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
  for (const method of ['auto', 'online', 'offline']) await expect(client.locator(`#pairing-${method}`)).toBeDisabled();
  await networkHint(client, false);
  const next = await freshOfflineOffer(page, tool, offer); await acceptOfflineReply(page, reply);
  await expect(page.locator('#offline-accept-status')).toContainText(/match|invalid|another/i);
  expect(await client.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  expect(await microphoneEnabled(page)).toBe(false);
  if (!walkie) await expect(page.locator('#vi-participants > li')).toHaveCount(0);
  await client.locator(`#${prefix}-offline-cancel`).click();
  const fresh = await context.newPage(); await prepareVoice(fresh, tool, 'deny');
  const freshReply = await createOfflineReply(fresh, tool, next);
  await page.evaluate(expires => { Date.now = () => expires + 1; }, JSON.parse(next).expires);
  await acceptOfflineReply(page, freshReply);
  await expect(page.locator('#offline-accept-status')).toContainText(/expired/i);
  expect(await fresh.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
  await page.locator(`#${prefix}-end`).click(); await fresh.locator(`#${prefix}-offline-cancel`).click();
  if (walkie) await tracksStopped(page);
  await offlinePeersClosed(page, client, fresh);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await offlinePeersClosed(page, client, fresh);
});
