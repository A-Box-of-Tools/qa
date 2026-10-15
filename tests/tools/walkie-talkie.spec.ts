import { test, expect } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL } from '../../lib/site';
import { withoutThirdParties } from '../../lib/engine';
import { admitsLiveVoice, liveVoiceEndpoint, voiceHooks, receivedAudio, tracksStopped, peersClosed, microphoneEnabled, installVoiceLifecycle, voiceConnectionState, captureAttached } from '../../lib/voice-fixtures';

const TOOL = '/walkie-talkie/';
const exists = discoverTools().includes('walkie-talkie');
// Parallel QA workers share the live service's address budget. Allow a rejected
// discovery socket to retry after its reconnect delay and the minute window.
const DISCOVERY_TIMEOUT = 75_000;

test.describe('walkie-talkie', () => {
  // These live channels share the service's per-address connection budget.
  // Run them one at a time while allowing later cases to run after a failure.
  test.describe.configure({ mode: 'default' });

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
    test.setTimeout(180_000);
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
      await expect(listener.locator('#wt-discovery-status')).toHaveText('Nearby channels update automatically.', { timeout: DISCOVERY_TIMEOUT });
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
      // Supply one busy response while the native peer is carrying speech.
      // Snapshot before the retry can hide an incorrect inactive UI state.
      expect(await page.evaluate(async () => {
        const qa = (window as any).__voiceQA;
        const socket = qa.sockets.find((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/broadcast/') && socket.readyState === WebSocket.OPEN);
        if (!socket) throw new Error('The host has no live signaling socket.');
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', error: 'busy' }) }));
        await Promise.resolve();
        const shown = (id: string) => !(document.getElementById(id) as HTMLElement).hidden;
        return { enabled: qa.tracks.some((track: MediaStreamTrack) => track.readyState === 'live' && track.enabled),
          controls: shown('wt-transmit'), banner: shown('wt-live-banner'), start: shown('wt-start'),
          pressed: document.getElementById('wt-toggle')!.getAttribute('aria-pressed') };
      })).toEqual({ enabled: true, controls: true, banner: true, start: false, pressed: 'true' });
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
    test.setTimeout(180_000);
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
      expect(await microphoneEnabled(page)).toBe(false);
      await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'false');
      await expect(page.locator('#wt-live-banner')).toBeHidden();
      await expect(page.locator('#wt-publication')).toHaveText('Your channel is listed nearby.', { timeout: DISCOVERY_TIMEOUT });
      const channel = listener.locator('#wt-channels > li').filter({ hasText: channelName });
      await expect(channel).toHaveCount(1, { timeout: DISCOVERY_TIMEOUT });
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
      await test.info().attach('walkie-hands-free-active', {
        body: await page.locator('#wt-transmit').screenshot(), contentType: 'image/png',
      });
      await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#wt-toggle')).toHaveText('Stop talking');
      await expect(page.locator('#wt-hold')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'true');
      await expect(page.locator('#wt-live-banner')).toBeVisible();
      await expect(page.locator('#wt-live-banner')).toContainText('Microphone on');
      await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(before.energy);
      await expect.poll(async () => (await receivedAudio(listener)).packets).toBeGreaterThan(before.packets);
      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(false);
      await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'false');
      await expect(page.locator('#wt-live-banner')).toBeHidden();

      // Held transmission must not present itself as hands-free transmission.
      await page.locator('#wt-hold').focus();
      await page.keyboard.down('Space');
      try {
        await expect.poll(() => microphoneEnabled(page)).toBe(true);
        await expect(page.locator('#wt-hold')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'false');
        await expect(page.locator('#wt-live-banner')).toBeHidden();
      } finally {
        await page.keyboard.up('Space');
      }
      await expect.poll(() => microphoneEnabled(page)).toBe(false);

      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(true);
      await expect(page.locator('#wt-live-banner')).toBeVisible();
      await page.locator('#wt-microphone').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(false);
      await expect(page.locator('#wt-microphone')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hold')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'false');
      await expect(page.locator('#wt-live-banner')).toBeHidden();
      await page.locator('#wt-microphone').click();
      await expect(page.locator('#wt-microphone')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => microphoneEnabled(page)).toBe(false);
      await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'false');
      await expect(page.locator('#wt-live-banner')).toBeHidden();

      await listener.locator('#wt-leave').click();
      await expect(listener.locator('#wt-nearby')).toBeVisible();
      await expect(listener.locator('#wt-setup')).toBeVisible();
      await expect(listener.locator('#wt-listener')).toBeHidden();
      expect(new URL(listener.url()).hash).toBe('');
      expect(await listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) => audio.srcObject)).toBeNull();
      await peersClosed(listener);
      await expect(channel).toHaveCount(1, { timeout: DISCOVERY_TIMEOUT });
      await channel.getByRole('button', { name: `Join ${channelName}`, exact: true }).click();
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(true);
      await expect(page.locator('#wt-live-banner')).toBeVisible();
      await page.locator('#wt-end').click();
      await tracksStopped(page);
      expect(await microphoneEnabled(page)).toBe(false);
      await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hold')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('#wt-hands-free')).toHaveAttribute('data-active', 'false');
      await expect(page.locator('#wt-live-banner')).toBeHidden();
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

  test('simulated background use preserves live pairing and microphone recovery stays silent', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'This lifecycle simulation uses native Chromium media; it is not a physical screen-lock test.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(180_000);
    const listenerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const listener = await listenerContext.newPage();
      await withoutThirdParties(listener);
      // Directory behavior is covered above; retain real room signaling and RTP.
      await voiceHooks(page, 'allow', true);
      await voiceHooks(listener, 'deny', true);
      await page.goto(TOOL);
      await installVoiceLifecycle(page);
      const attempts = () => page.evaluate(() => (window as any).__voiceLifecycle.attempts);
      const silent = async () => {
        expect(await microphoneEnabled(page)).toBe(false);
        await expect(page.locator('#wt-toggle')).toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('#wt-live-banner')).toBeHidden();
      };
      await page.locator('#wt-room-name').fill('QA lifecycle ' + test.info().workerIndex + '-' + Date.now());
      await page.locator('#wt-discover').uncheck();
      await page.locator('#wt-start').click();
      await expect(page.locator('#wt-status-text')).toHaveText('Channel open. Hold to talk when you are ready.', { timeout: 20_000 });
      const invitation = await page.locator('#wt-link').inputValue();
      await listener.goto(invitation);
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await expect.poll(() => listener.locator('#wt-audio').evaluate((audio: HTMLAudioElement) =>
        Boolean(audio.srcObject) && (!audio.paused || !document.getElementById('wt-playback-note')!.hidden))).toBe(true);
      if (await listener.locator('#wt-playback-note').isVisible()) await listener.locator('#wt-mute').click();
      await expect.poll(() => captureAttached(page)).toBe(true);
      const connection = await voiceConnectionState(page, 'broadcast');
      // A rejected startup handshake can retry before pairing succeeds. Keep
      // its socket history in the baseline so later reconnects still fail.
      expect(connection).toMatchObject({ peers: 1, connected: 1, open: 1 });
      expect(await attempts()).toBe(1);

      await page.locator('#wt-toggle').click();
      await expect.poll(() => microphoneEnabled(page)).toBe(true);
      const beforeHidden = await receivedAudio(listener);
      await page.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        window.dispatchEvent(new Event('blur'));
      });
      expect(await microphoneEnabled(page)).toBe(true);
      await expect(page.locator('#wt-live-banner')).toBeVisible();
      await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(beforeHidden.energy);
      expect(await voiceConnectionState(page, 'broadcast')).toEqual(connection);
      expect(await attempts()).toBe(1);
      await page.evaluate(() => (window as any).__voiceLifecycle.setHidden(false));
      await page.locator('#wt-toggle').click();
      await silent();

      // A held key is not a persistent authorization to speak in the background.
      for (const event of ['blur', 'hidden']) {
        await page.locator('#wt-hold').focus();
        await page.keyboard.down('Space');
        try {
          await expect.poll(() => microphoneEnabled(page)).toBe(true);
          await page.evaluate(event => {
            if (event === 'hidden') (window as any).__voiceLifecycle.setHidden(true);
            else window.dispatchEvent(new Event('blur'));
          }, event);
          await silent();
        } finally {
          await page.keyboard.up('Space');
          await page.evaluate(() => (window as any).__voiceLifecycle.setHidden(false));
        }
      }
      expect(await voiceConnectionState(page, 'broadcast')).toEqual(connection);
      expect(await attempts()).toBe(1);

      // Native source interruption changes the track flag as well as its event.
      await page.locator('#wt-toggle').click();
      await page.evaluate(() => {
        (window as any).__voiceLifecycle.interrupt('mute');
        (window as any).__voiceLifecycle.setHidden(true);
      });
      await silent();
      await expect(page.locator('#wt-resume-microphone')).toBeVisible();
      await expect(page.locator('#wt-hold')).toBeDisabled();
      expect(await voiceConnectionState(page, 'broadcast')).toEqual(connection);
      await page.evaluate(() => (window as any).__voiceLifecycle.setHidden(false));
      expect(await attempts()).toBe(1);
      await page.evaluate(() => (window as any).__voiceLifecycle.interrupt('unmute'));
      await expect(page.locator('#wt-resume-microphone')).toBeHidden();
      await expect(page.locator('#wt-hold')).toBeEnabled();
      await silent();
      expect(await attempts()).toBe(1);

      // Denied automatic replacement leaves the same live peer and a manual
      // action, rather than retrying capture on every foreground notification.
      await page.locator('#wt-toggle').click();
      await page.evaluate(() => {
        const lifecycle = (window as any).__voiceLifecycle;
        lifecycle.interrupt('ended');
        lifecycle.denyNextCapture = true;
        lifecycle.setHidden(true);
        lifecycle.setHidden(false);
      });
      await expect.poll(attempts).toBe(2);
      await expect(page.locator('#wt-resume-microphone')).toHaveText('Resume microphone');
      await expect(page.locator('#wt-resume-microphone')).toBeEnabled();
      await silent();
      expect(await voiceConnectionState(page, 'broadcast')).toEqual(connection);
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      });
      expect(await attempts()).toBe(2);
      await page.locator('#wt-resume-microphone').click();
      await expect(page.locator('#wt-resume-microphone')).toBeHidden();
      await expect.poll(() => captureAttached(page)).toBe(true);
      expect(await attempts()).toBe(3);
      await silent();
      expect(await voiceConnectionState(page, 'broadcast')).toEqual(connection);
      await expect(page.locator('#wt-link')).toHaveValue(invitation);
      const beforeReplacement = await receivedAudio(listener);
      await page.locator('#wt-toggle').click();
      await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(beforeReplacement.energy);

      // A later ended capture can recover once automatically, still silently.
      await page.evaluate(() => {
        const lifecycle = (window as any).__voiceLifecycle;
        lifecycle.interrupt('ended');
        lifecycle.setHidden(true);
        lifecycle.setHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      });
      await expect(page.locator('#wt-resume-microphone')).toBeHidden();
      await expect.poll(() => captureAttached(page)).toBe(true);
      expect(await attempts()).toBe(4);
      await silent();
      expect(await voiceConnectionState(page, 'broadcast')).toEqual(connection);

      // A history suspension closes media, unlike ordinary hiding. A visible
      // event before pageshow must not start capture while still suspended.
      await page.locator('#wt-toggle').click();
      await page.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });
      await tracksStopped(page);
      await peersClosed(page);
      await silent();
      await page.evaluate(() => (window as any).__voiceLifecycle.setHidden(false));
      expect(await attempts()).toBe(4);
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(page.locator('#wt-status-text')).toHaveText('Channel open. Hold to talk when you are ready.', { timeout: 20_000 });
      await expect(page.locator('#wt-link')).toHaveValue(invitation);
      await expect(listener.locator('#wt-status-text')).toHaveText('Connected. Waiting for the host to speak.', { timeout: 20_000 });
      await expect.poll(() => captureAttached(page)).toBe(true);
      expect(await attempts()).toBe(5);
      await silent();
      const beforeReturn = await receivedAudio(listener);
      await page.locator('#wt-toggle').click();
      await expect.poll(async () => (await receivedAudio(listener)).energy, { timeout: 20_000 }).toBeGreaterThan(beforeReturn.energy);
      await page.locator('#wt-end').click();
      await tracksStopped(page);
      await peersClosed(page);
      await expect(listener.locator('#wt-status-text')).toHaveText('The host ended this broadcast.');
      await page.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        (window as any).__voiceLifecycle.setHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(await attempts()).toBe(5);
      expect((await voiceConnectionState(page, 'broadcast')).open).toBe(0);
      await expect(page.locator('#wt-start')).toHaveText('Start channel');
      await expect(page.locator('#wt-start')).toBeEnabled();
      await silent();
      expect(await page.evaluate(() => sessionStorage.getItem('walkie-talkie.host'))).toBeNull();
      expect(await listener.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    } finally {
      await listenerContext.close();
    }
  });
});
