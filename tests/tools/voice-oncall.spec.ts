import { test, expect } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL } from '../../lib/site';
import { withoutThirdParties } from '../../lib/engine';
import { admitsLiveVoice, liveVoiceEndpoint, voiceHooks, receivedAudio, tracksStopped, peersClosed, microphoneEnabled, outputRms, voiceSnapshot } from '../../lib/voice-fixtures';

const TOOL = '/voice-oncall/';
const exists = discoverTools().includes('voice-oncall');

test.describe('voice-oncall', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!exists, 'Voice Oncall is awaiting the website release.');
    await withoutThirdParties(page);
  });

  test('denied microphone permission offers deliberate recovery without opening a voice socket', async ({ page }) => {
    await voiceHooks(page, 'deny', true);
    await page.goto(`${TOOL}#code=${'a'.repeat(64)}`);
    await expect(page.locator('#vi-sender-name')).toHaveCount(0);
    await page.locator('#vi-join').click();
    await expect(page.locator('#vi-status-text')).toHaveText('The microphone stopped or could not start. Check microphone permission and try again.');
    await expect(page.locator('#vi-resume')).toBeVisible();
    await expect(page.locator('#vi-hold')).toBeDisabled();
    expect(await page.evaluate(() => {
      const qa = (window as any).__voiceQA;
      return { calls: qa.calls, tracks: qa.tracks.length, peers: qa.peers.length,
        rooms: qa.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length };
    })).toEqual({ calls: [{ audio: true, video: false }], tracks: 0, peers: 0, rooms: 0 });
    await page.locator('#vi-leave').click();
    await expect(page.locator('#vi-join-form')).toBeVisible();
  });

  test('a protected live pager rejects a wrong password, receives native audio and enforces host mute', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; refusal and frame checks also run in WebKit.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(90_000);
    const endpoint = liveVoiceEndpoint();
    const password = 'QA-only-voice-pager-4c8a';
    const senderContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const sender = await senderContext.newPage();
      await withoutThirdParties(sender);
      await voiceHooks(page, 'deny');
      await voiceHooks(sender, 'allow');
      await page.goto(TOOL);
      await page.locator('#vi-tab-host').click();
      await page.locator('#vi-room-name').fill('QA synthetic voice pager');
      await page.locator('#vi-password-required').check();
      await page.locator('#vi-host-password').fill(password);
      await page.locator('#vi-start').click();
      await expect(page.locator('#vi-status-text')).toHaveText('Your pager is open.', { timeout: 20_000 });
      expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
      const invitation = await page.locator('#vi-link').inputValue();
      expect(new URL(invitation).hash).toMatch(/^#code=[a-f0-9]{64}$/);
      expect(invitation).not.toContain(password);
      await sender.goto(invitation);
      await expect(sender.locator('#vi-sender-name')).toHaveCount(0);
      await sender.locator('#vi-sender-password').fill('QA-incorrect-password');
      await sender.locator('#vi-join').click();
      await expect(sender.locator('#vi-status-text')).toHaveText('That password did not match. Enter the pager password and try again.', { timeout: 20_000 });
      await tracksStopped(sender);
      await expect(page.locator('#vi-participants > li')).toHaveCount(0);
      expect(await sender.evaluate(() => (window as any).__voiceQA.peers.length)).toBe(0);

      await sender.locator('#vi-sender-password').fill(password);
      await sender.locator('#vi-join').click();
      await expect(sender.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.', { timeout: 20_000 });
      await expect(page.locator('#vi-participant-count')).toHaveText('1 person connected');
      const caller = page.locator('#vi-participants .vi-participant-name');
      await expect(caller).toHaveText(/^Caller [a-f0-9]{6,64}$/);
      const callerName = await caller.innerText();
      expect(await sender.evaluate(() => {
        const records = JSON.parse(sessionStorage.getItem('voice-oncall.senders') || '{}');
        return Object.values(records).some(record => Object.hasOwn(record as object, 'name'));
      })).toBe(false);
      expect(await microphoneEnabled(sender)).toBe(false);
      expect(await page.evaluate(() => (window as any).__voiceQA.peers.flatMap((peer: RTCPeerConnection) => peer.getSenders()).filter((sender: RTCRtpSender) => sender.track).length)).toBe(0);
      expect(await page.evaluate((endpoint) => (window as any).__voiceQA.sockets.some((socket: WebSocket) => socket.url.startsWith(`${endpoint}/inbox/`) && socket.readyState === WebSocket.OPEN), endpoint)).toBe(true);
      await expect.poll(() => outputRms(page)).toBeLessThan(0.00001);
      const before = await receivedAudio(page);
      await sender.locator('#vi-toggle').click();
      await expect.poll(() => microphoneEnabled(sender)).toBe(true);
      try {
        await expect.poll(() => outputRms(page), { timeout: 20_000 }).toBeGreaterThan(0.01);
      } catch (error) {
        const diagnostics = { host: await voiceSnapshot(page), sender: await voiceSnapshot(sender) };
        await test.info().attach('voice-audio-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
        throw error;
      }
      await expect.poll(async () => (await receivedAudio(page)).packets).toBeGreaterThan(before.packets);

      // Keep the speaking page focused: foregrounding the other test window
      // would intentionally pause capture before its host can moderate it.
      await page.getByRole('button', { name: `Mute ${callerName}`, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('The host muted you. Wait for the host to unmute you.');
      await expect.poll(() => microphoneEnabled(sender)).toBe(false);
      expect(await page.evaluate(() => {
        const gains: GainNode[] = (window as any).__voiceQA.gains;
        return gains.length > 0 && gains.every(gain => gain.gain.value === 0);
      })).toBe(true);
      await expect.poll(() => outputRms(page)).toBeLessThan(0.00001);
      await page.getByRole('button', { name: `Unmute ${callerName}`, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.');
      expect(await microphoneEnabled(sender)).toBe(false);
      await expect.poll(() => page.evaluate(() => (window as any).__voiceQA.gains.some((gain: GainNode) => gain.gain.value === 1))).toBe(true);
      await sender.locator('#vi-toggle').click();
      await expect.poll(() => outputRms(page)).toBeGreaterThan(0.01);
      await page.locator('#vi-end').evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('The host ended this pager.');
      await tracksStopped(sender);
      await peersClosed(sender);
      await peersClosed(page);
      await expect.poll(() => page.evaluate(() => {
        const contexts: AudioContext[] = (window as any).__voiceQA.contexts;
        return contexts.length > 0 && contexts.every(context => context.state === 'closed');
      })).toBe(true);
      expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
      expect(await page.evaluate(() => sessionStorage.getItem('voice-oncall.host'))).toBeNull();
    } finally {
      await senderContext.close();
    }
  });

  test('an anonymous caller reconnects with the same label and stays removed after reloading', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; refusal and frame checks also run in WebKit.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(90_000);
    const senderContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const sender = await senderContext.newPage();
      await withoutThirdParties(sender);
      await voiceHooks(page, 'deny');
      await voiceHooks(sender, 'allow');
      await page.goto(TOOL);
      await page.locator('#vi-tab-host').click();
      await page.locator('#vi-room-name').fill(`QA removal ${test.info().workerIndex}-${Date.now()}`);
      await page.locator('#vi-start').click();
      await expect(page.locator('#vi-status-text')).toHaveText('Your pager is open.', { timeout: 20_000 });
      await sender.goto(await page.locator('#vi-link').inputValue());
      await expect(sender.locator('#vi-sender-name')).toHaveCount(0);
      await sender.locator('#vi-join').click();
      await expect(sender.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.', { timeout: 20_000 });
      await expect.poll(() => sender.evaluate(() =>
        (window as any).__voiceQA.peers.some((peer: RTCPeerConnection) => peer.connectionState === 'connected')),
      { timeout: 20_000 }).toBe(true);
      const caller = page.locator('#vi-participants .vi-participant-name');
      await expect(caller).toHaveText(/^Caller [a-f0-9]{6,64}$/);
      const callerName = await caller.innerText();
      const previousSockets = await sender.evaluate(() =>
        (window as any).__voiceQA.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length);
      await sender.evaluate(() => {
        const socket = (window as any).__voiceQA.sockets.find((socket: WebSocket) =>
          new URL(socket.url).pathname.startsWith('/inbox/') && socket.readyState === WebSocket.OPEN);
        if (!socket) throw new Error('The sender has no live signaling socket.');
        socket.close(1000, 'QA reconnect');
      });
      await expect.poll(() => sender.evaluate(() =>
        (window as any).__voiceQA.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length),
      { timeout: 20_000 }).toBeGreaterThan(previousSockets);
      await expect(sender.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.', { timeout: 20_000 });
      await expect(page.locator('#vi-participant-count')).toHaveText('1 person connected');
      await expect(caller).toHaveText(callerName);
      await page.getByRole('button', { name: `Remove ${callerName}`, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('The host removed you from this pager.');
      await tracksStopped(sender);
      await peersClosed(sender);
      await expect(page.locator('#vi-participants > li')).toHaveCount(0);
      await sender.reload();
      await expect(sender.locator('#vi-status-text')).toHaveText('The host removed you from this pager.');
      await expect(sender.locator('#vi-sender-name')).toHaveCount(0);
      await expect(sender.locator('#vi-join-form')).toBeHidden();
      await expect(sender.locator('#vi-resume')).toBeHidden();
      expect(await sender.evaluate(() => {
        const qa = (window as any).__voiceQA;
        return { calls: qa.calls.length, tracks: qa.tracks.length,
          rooms: qa.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length };
      })).toEqual({ calls: 0, tracks: 0, rooms: 0 });
      await expect(page.locator('#vi-participants > li')).toHaveCount(0);
      await page.locator('#vi-end').evaluate((button: HTMLButtonElement) => button.click());
      await peersClosed(page);
      expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    } finally {
      await senderContext.close();
    }
  });
});
