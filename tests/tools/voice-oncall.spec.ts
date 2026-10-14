import { test, expect } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL } from '../../lib/site';
import { withoutThirdParties } from '../../lib/engine';
import { admitsLiveVoice, liveVoiceEndpoint, voiceHooks, receivedAudio, tracksStopped, peersClosed, microphoneEnabled, voiceSnapshot } from '../../lib/voice-fixtures';

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
    await page.locator('#vi-sender-name').fill('QA denied speaker');
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
      await sender.locator('#vi-sender-name').fill('QA speaker');
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
      expect(await microphoneEnabled(sender)).toBe(false);
      expect(await page.evaluate(() => (window as any).__voiceQA.peers.flatMap((peer: RTCPeerConnection) => peer.getSenders()).filter((sender: RTCRtpSender) => sender.track).length)).toBe(0);
      expect(await page.evaluate((endpoint) => (window as any).__voiceQA.sockets.some((socket: WebSocket) => socket.url.startsWith(`${endpoint}/inbox/`) && socket.readyState === WebSocket.OPEN), endpoint)).toBe(true);
      const before = await receivedAudio(page);
      await sender.locator('#vi-toggle').click();
      await expect.poll(() => microphoneEnabled(sender)).toBe(true);
      try {
        await expect.poll(async () => (await receivedAudio(page)).energy, { timeout: 20_000 }).toBeGreaterThan(before.energy);
      } catch (error) {
        const diagnostics: unknown[] = [{ stage: 'before decoder probe', host: await voiceSnapshot(page), sender: await voiceSnapshot(sender) }];
        // This probe runs only after the real assertion has failed and never changes its result.
        // The stream is the test oscillator, so no person's audio is played or recorded.
        for (const volume of [0, 1]) {
          const probeResult = await page.evaluate(async volume => {
            const qa = (window as any).__voiceQA;
            if (!qa.decodeProbe) {
              const stream = document.querySelector('audio')?.srcObject;
              if (!stream) return 'no stream';
              qa.decodeProbe = document.createElement('audio');
              qa.decodeProbe.srcObject = stream;
              document.body.append(qa.decodeProbe);
            }
            qa.decodeProbe.muted = false;
            qa.decodeProbe.volume = volume;
            try { await qa.decodeProbe.play(); return 'playing'; }
            catch (error) { return (error as DOMException).name; }
          }, volume);
          await expect.poll(async () => (await receivedAudio(page)).energy, { timeout: 3_000 }).toBeGreaterThan(before.energy).catch(() => {});
          diagnostics.push({ stage: `unmuted decoder volume ${volume}`, probeResult, host: await voiceSnapshot(page), sender: await voiceSnapshot(sender) });
        }
        await page.evaluate(() => {
          const qa = (window as any).__voiceQA;
          qa.gains.forEach((gain: GainNode) => { gain.gain.value = 0; });
          const context = qa.contexts[0] as AudioContext;
          const source = context.createMediaElementSource(qa.decodeProbe);
          const gain = context.createGain(); gain.gain.value = 1;
          source.connect(gain).connect(context.destination);
        });
        const routed = await receivedAudio(page);
        await expect.poll(async () => (await receivedAudio(page)).energy, { timeout: 3_000 }).toBeGreaterThan(routed.energy).catch(() => {});
        diagnostics.push({ stage: 'element routed through gain', host: await voiceSnapshot(page), sender: await voiceSnapshot(sender) });
        await test.info().attach('voice-audio-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
        throw error;
      }
      await expect.poll(async () => (await receivedAudio(page)).packets).toBeGreaterThan(before.packets);

      // Keep the speaking page focused: foregrounding the other test window
      // would intentionally pause capture before its host can moderate it.
      await page.getByRole('button', { name: 'Mute QA speaker', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('The host muted you. Wait for the host to unmute you.');
      await expect.poll(() => microphoneEnabled(sender)).toBe(false);
      expect(await page.evaluate(() => {
        const gains: GainNode[] = (window as any).__voiceQA.gains;
        return gains.length > 0 && gains.every(gain => gain.gain.value === 0);
      })).toBe(true);
      await page.getByRole('button', { name: 'Unmute QA speaker', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('Connected. Hold to talk when you are ready.');
      expect(await microphoneEnabled(sender)).toBe(false);
      await expect.poll(() => page.evaluate(() => (window as any).__voiceQA.gains.some((gain: GainNode) => gain.gain.value === 1))).toBe(true);
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
});
