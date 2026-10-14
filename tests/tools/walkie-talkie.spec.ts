import { test, expect } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL } from '../../lib/site';
import { withoutThirdParties } from '../../lib/engine';
import { admitsLiveVoice, liveVoiceEndpoint, voiceHooks, receivedAudio, tracksStopped, peersClosed, microphoneEnabled } from '../../lib/voice-fixtures';

const TOOL = '/walkie-talkie/';
const exists = discoverTools().includes('walkie-talkie');

test.describe('walkie-talkie', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!exists, 'Local Walkie-Talkie is awaiting the website release.');
    await withoutThirdParties(page);
  });

  test('denied microphone permission leaves no capture or pairing session', async ({ page }) => {
    await voiceHooks(page, 'deny', true);
    await page.goto(TOOL);
    await page.locator('#wt-start').click();
    await expect(page.locator('#wt-error-text')).toContainText('The microphone stopped or could not start.');
    await expect(page.locator('#wt-start')).toBeEnabled();
    await expect(page.locator('#wt-transmit')).toBeHidden();
    expect(await page.evaluate(() => {
      const qa = (window as any).__voiceQA;
      return { calls: qa.calls, tracks: qa.tracks.length, peers: qa.peers.length,
        rooms: qa.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/broadcast/')).length };
    })).toEqual({ calls: [{ audio: true, video: false }], tracks: 0, peers: 0, rooms: 0 });
  });

  test('an unlisted channel pairs by invitation, delivers native audio receive-only and releases both sides', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; refusal and frame checks also run in WebKit.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(75_000);
    const endpoint = liveVoiceEndpoint();
    const channelName = `QA invite only ${test.info().workerIndex}-${Date.now()}`;
    const listenerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const listener = await listenerContext.newPage();
      await withoutThirdParties(listener);
      await voiceHooks(page, 'allow');
      await voiceHooks(listener, 'deny');
      await page.goto(TOOL);
      await page.locator('#wt-room-name').fill(channelName);
      await page.locator('#wt-discover').uncheck();
      await page.locator('#wt-start').click();
      await expect(page.locator('#wt-status-text')).toHaveText('Channel open. Hold to talk when you are ready.', { timeout: 20_000 });
      expect(await microphoneEnabled(page)).toBe(false);
      const invitation = await page.locator('#wt-link').inputValue();
      expect(new URLSearchParams(new URL(invitation).hash.slice(1)).get('listen')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(page.locator('#wt-publication')).toBeHidden();
      await listener.goto(TOOL);
      await expect(listener.locator('#wt-discovery-status')).toHaveText('Nearby channels update automatically.', { timeout: 20_000 });
      await expect(listener.locator('#wt-channels > li').filter({ hasText: channelName })).toHaveCount(0);
      await listener.goto('about:blank');
      await listener.goto(invitation);
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await expect(page.locator('#wt-listener-count')).toHaveText('1 listener connected');
      await expect.poll(() => listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) =>
        Boolean(audio.srcObject) && (!audio.paused || !document.getElementById('wt-playback-note')!.hidden))).toBe(true);
      if (await listener.locator('#wt-playback-note').isVisible()) await listener.locator('#wt-mute').click();
      await expect.poll(() => listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      expect(await listener.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
      expect(await listener.evaluate(() => (window as any).__voiceQA.peers.flatMap((peer: RTCPeerConnection) => peer.getSenders()).filter((sender: RTCRtpSender) => sender.track).length)).toBe(0);
      expect(await page.evaluate((endpoint) => (window as any).__voiceQA.sockets.some((socket: WebSocket) => socket.url.startsWith(`${endpoint}/broadcast/`) && socket.readyState === WebSocket.OPEN), endpoint)).toBe(true);

      const before = await receivedAudio(listener);
      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(true);
      await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(before.energy);
      await expect.poll(async () => (await receivedAudio(listener)).packets).toBeGreaterThan(before.packets);
      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(false);

      await listener.locator('#wt-leave').click();
      await expect(listener.locator('#wt-status-text')).toHaveText('You left the broadcast.');
      await expect(listener.locator('#wt-nearby')).toBeVisible();
      await expect(listener.locator('#wt-start')).toBeVisible();
      await expect(listener.locator('#wt-listener')).toBeHidden();
      expect(await listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) => audio.srcObject)).toBeNull();
      await peersClosed(listener);
      await expect(page.locator('#wt-status-text')).toHaveText('Channel open. Hold to talk when you are ready.');
      // Invitations are read at startup; a fragment-only navigation does not restart the page.
      await listener.goto('about:blank');
      await listener.goto(invitation);
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await page.locator('#wt-end').click();
      await tracksStopped(page);
      await peersClosed(page);
      await expect(listener.locator('#wt-status-text')).toHaveText('The host ended this broadcast.');
      await peersClosed(listener);
      expect(await listener.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
      expect(await page.evaluate(() => sessionStorage.getItem('walkie-talkie.host'))).toBeNull();
    } finally {
      await listenerContext.close();
    }
  });

  test('a nearby channel joins without an invite, receives native audio and can be left and rejoined', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; refusal and frame checks also run in WebKit.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(90_000);
    const channelName = `QA nearby ${test.info().workerIndex}-${Date.now()}`;
    const listenerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const listener = await listenerContext.newPage();
      await withoutThirdParties(listener);
      await voiceHooks(page, 'allow');
      await voiceHooks(listener, 'deny');
      // Nearby joining must retain a reloadable fragment when tab storage is
      // unavailable, without needing the host's copied invitation.
      await listener.addInitScript(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (this === window.sessionStorage && key === 'walkie-talkie.listener') {
            throw new DOMException('Tab storage is unavailable', 'QuotaExceededError');
          }
          return setItem.call(this, key, value);
        };
      });
      await listener.goto(TOOL);
      await expect(listener.locator('#wt-nearby')).toBeVisible();
      expect(new URL(listener.url()).hash).toBe('');
      expect(await listener.evaluate(() => ({ calls: (window as any).__voiceQA.calls.length,
        peers: (window as any).__voiceQA.peers.length }))).toEqual({ calls: 0, peers: 0 });
      await page.goto(TOOL);
      await page.locator('#wt-room-name').fill(channelName);
      await expect(page.locator('#wt-discover')).toBeChecked();
      await page.locator('#wt-start').click();
      await expect(page.locator('#wt-status-text')).toHaveText('Channel open. Hold to talk when you are ready.', { timeout: 20_000 });
      await expect(page.locator('#wt-publication')).toHaveText('Your channel is listed nearby.', { timeout: 20_000 });
      const channel = listener.locator('#wt-channels > li').filter({ hasText: channelName });
      await expect(channel).toHaveCount(1, { timeout: 20_000 });
      await expect(channel.locator('span')).toHaveText(channelName);
      await channel.getByRole('button', { name: `Join ${channelName}`, exact: true }).click();
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await expect(page.locator('#wt-listener-count')).toHaveText('1 listener connected');
      await expect(listener.locator('#wt-listener')).toBeVisible();
      await expect(listener.locator('#wt-start')).toBeHidden();
      await expect(listener.locator('#wt-nearby')).toBeHidden();
      const fragment = new URLSearchParams(new URL(listener.url()).hash.slice(1));
      expect(fragment.get('code')).toMatch(/^[a-f0-9]{64}$/);
      expect(fragment.get('listen')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await listener.evaluate(() => sessionStorage.getItem('walkie-talkie.listener'))).toBeNull();
      await listener.reload();
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await expect.poll(() => listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) =>
        Boolean(audio.srcObject) && (!audio.paused || !document.getElementById('wt-playback-note')!.hidden))).toBe(true);
      if (await listener.locator('#wt-playback-note').isVisible()) await listener.locator('#wt-mute').click();
      await expect.poll(() => listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) => !audio.paused && !audio.muted)).toBe(true);
      expect(await listener.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
      expect(await listener.evaluate(() => (window as any).__voiceQA.peers.flatMap((peer: RTCPeerConnection) => peer.getSenders()).filter((sender: RTCRtpSender) => sender.track).length)).toBe(0);
      const before = await receivedAudio(listener);
      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(true);
      await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(before.energy);
      await expect.poll(async () => (await receivedAudio(listener)).packets).toBeGreaterThan(before.packets);
      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(false);

      await listener.locator('#wt-leave').click();
      await expect(listener.locator('#wt-nearby')).toBeVisible();
      await expect(listener.locator('#wt-setup')).toBeVisible();
      await expect(listener.locator('#wt-listener')).toBeHidden();
      expect(new URL(listener.url()).hash).toBe('');
      expect(await listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) => audio.srcObject)).toBeNull();
      await peersClosed(listener);
      await expect(channel).toHaveCount(1, { timeout: 20_000 });
      await channel.getByRole('button', { name: `Join ${channelName}`, exact: true }).click();
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await page.locator('#wt-end').click();
      await tracksStopped(page);
      await peersClosed(page);
      await expect(listener.locator('#wt-status-text')).toHaveText('The host ended this broadcast.');
      await peersClosed(listener);
      await expect(channel).toHaveCount(0, { timeout: 20_000 });
      await listener.locator('#wt-leave').click();
      await expect(listener.locator('#wt-nearby')).toBeVisible();
      await expect(channel).toHaveCount(0);
      expect(await listener.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    } finally {
      await listenerContext.close();
    }
  });
});
