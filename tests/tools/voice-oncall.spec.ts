import { test, expect, type Page } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL, ETOOLBOX_DIR } from '../../lib/site';
import fs from 'node:fs';
import path from 'node:path';
import { withoutThirdParties } from '../../lib/engine';
import { privateDiscovery } from '../../lib/pairing-transport';
import { admitsLiveVoice, liveVoiceEndpoint, voiceHooks, receivedAudio, tracksStopped, peersClosed, microphoneEnabled, outputRms, voiceSnapshot, installVoiceLifecycle, voiceConnectionState, captureAttached } from '../../lib/voice-fixtures';

const TOOL = '/voice-oncall/';
const exists = discoverTools().includes('voice-oncall');
const topLevelNearby = exists && fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/voice-oncall/body.html'), 'utf8').includes('data-pairing-nearby');
// Discovery must recover within the live service's shared per-address budget.
const DISCOVERY_TIMEOUT = 75_000;

async function nativeRadioNavigation(page: Page) {
  const probe = await page.context().newPage();
  try {
    await probe.setContent('<label>First<input id="first" type="radio" name="native-probe"></label><label>Last<input id="last" type="radio" name="native-probe" checked></label>');
    const first = probe.locator('#first'), last = probe.locator('#last');
    await last.focus(); await last.press('ArrowRight');
    const edge = { first: await first.isChecked(), last: await last.isChecked() };
    // WebKit stops at the group edge; Chromium wraps. The application's
    // contract is preserving native adjacent navigation, not imposing wrap.
    await last.check(); await last.focus(); await last.press('ArrowLeft');
    await expect(first).toBeChecked(); await expect(first).toBeFocused();
    await test.info().attach('native-radio-navigation', {
      body: JSON.stringify({ edge, adjacentNavigation: 'passed' }), contentType: 'application/json',
    });
  } finally { await probe.close(); }
}

async function suspendVoicePage(page: Page) {
  await page.evaluate(() => {
    (window as any).__voiceLifecycle.setHidden(true);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  // All native close handshakes must finish before reopening the host, so the
  // worker has no remaining socket from which to recover moderation metadata.
  await expect.poll(() => page.evaluate(() => (window as any).__voiceQA.sockets
    .filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/'))
    .every((socket: WebSocket) => socket.readyState === WebSocket.CLOSED)), { timeout: 20_000 }).toBe(true);
}

async function returnVoicePage(page: Page) {
  await page.evaluate(() => {
    (window as any).__voiceLifecycle.setHidden(false);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
}

async function observeProtection(page: Page, dropNextKick = false) {
  await page.evaluate(dropNextKick => {
    const state = (window as any).__voiceProtectionQA = { sent: [] as { type: string; muted?: boolean }[], dropNextKick, dropped: 0 };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: Parameters<WebSocket['send']>[0]) {
      if (typeof data === 'string' && data.startsWith('{')) {
        const frame = JSON.parse(data);
        if (frame.type === 'kick' && state.dropNextKick) { state.dropNextKick = false; state.dropped++; return; }
        if (frame.type === 'kick' || frame.type === 'moderate') state.sent.push({ type: frame.type, ...(frame.type === 'moderate' ? { muted: frame.muted } : {}) });
      }
      return send.call(this, data);
    };
  }, dropNextKick);
}

test.describe('voice-oncall', () => {
  // Recovery adds real room handshakes within the shared service address budget.
  test.describe.configure({ mode: 'default' });
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

  test('choosing a nearby pager from Host opens Connect without asking for a microphone', async ({ page }) => {
    test.skip(!topLevelNearby, 'The shared nearby area is awaiting the website release.');
    await nativeRadioNavigation(page);
    const code = 'a'.repeat(64), openCode = 'b'.repeat(64);
    await voiceHooks(page, 'deny', true, [{ code, name: 'QA protected pager', locked: true },
      { code: openCode, name: 'QA open pager', locked: false }]);
    await page.goto(TOOL);
    await page.locator('#vi-tab-host').click();
    await expect(page.locator('#vi-nearby')).toBeVisible();
    const protectedPager = page.locator(`#vi-rooms input[value="${code}"]`);
    const openPager = page.locator(`#vi-rooms input[value="${openCode}"]`);
    await protectedPager.check();
    await expect(page.locator('#vi-tab-join')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#vi-sender-password')).toBeFocused();
    await expect(page.locator('#vi-sender-name')).toHaveCount(0);
    expect(await page.evaluate(() => {
      const qa = (window as any).__voiceQA;
      return { calls: qa.calls.length, peers: qa.peers.length,
        rooms: qa.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length,
        saved: sessionStorage.getItem('voice-oncall.senders') };
    })).toEqual({ calls: 0, peers: 0, rooms: 0, saved: null });
    await page.locator('#vi-tab-host').click();
    await protectedPager.focus(); await protectedPager.press('ArrowLeft');
    await expect(openPager).toBeChecked(); await expect(openPager).toBeFocused();
    await expect(page.locator('#vi-tab-join')).toHaveAttribute('aria-selected', 'true');
    await openPager.press('ArrowRight');
    await expect(protectedPager).toBeChecked(); await expect(protectedPager).toBeFocused();
    expect(await page.evaluate(() => [(window as any).__voiceQA.calls.length,
      (window as any).__voiceQA.peers.length,
      (window as any).__voiceQA.sockets.filter((socket: WebSocket) => new URL(socket.url).pathname.startsWith('/inbox/')).length])).toEqual([0, 0, 0]);
    // Clicking the already-selected pager must still return from Host to its
    // confirmation controls; keyboard selection keeps native radio navigation.
    await page.locator('#vi-tab-host').click(); await protectedPager.click();
    await expect(page.locator('#vi-tab-join')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#vi-sender-password')).toBeFocused();
    await page.locator('#vi-sender-password').fill('QA test password');
    await page.locator('#vi-join').click();
    await expect(page.locator('#vi-status-text')).toContainText('The microphone stopped or could not start.');
    expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(1);
  });

  test('a protected live pager preserves background audio and recovers capture without losing host moderation', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; refusal and frame checks also run in WebKit.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(150_000);
    const endpoint = liveVoiceEndpoint();
    const password = 'QA-only-voice-pager-4c8a';
    const senderContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const sender = await senderContext.newPage();
      await withoutThirdParties(sender);
      await voiceHooks(page, 'deny');
      await voiceHooks(sender, 'allow');
      await page.goto(TOOL);
      await installVoiceLifecycle(page);
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
      await installVoiceLifecycle(sender);
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

      // Synthetic notifications exercise lifecycle policy, not OS lock support.
      const connection = await voiceConnectionState(sender, 'inbox');
      const hostConnection = await voiceConnectionState(page, 'inbox');
      expect(connection.connected).toBe(1);
      expect(connection.open).toBe(1);
      const attempts = () => sender.evaluate(() => (window as any).__voiceLifecycle.attempts);
      expect(await attempts()).toBe(2); // Refused password, then admitted capture.
      const beforeHidden = await receivedAudio(page);
      for (const participant of [page, sender]) await participant.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        window.dispatchEvent(new Event('blur'));
      });
      expect(await microphoneEnabled(sender)).toBe(true);
      await expect(sender.locator('#vi-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await receivedAudio(page)).packets).toBeGreaterThan(beforeHidden.packets);
      await expect.poll(() => outputRms(page)).toBeGreaterThan(0.01);
      expect(await voiceConnectionState(sender, 'inbox')).toEqual(connection);
      expect(await voiceConnectionState(page, 'inbox')).toEqual(hostConnection);
      for (const participant of [page, sender]) await participant.evaluate(() => (window as any).__voiceLifecycle.setHidden(false));

      await sender.evaluate(() => (window as any).__voiceLifecycle.interrupt('mute'));
      expect(await microphoneEnabled(sender)).toBe(false);
      await expect(sender.locator('#vi-toggle')).toHaveAttribute('aria-pressed', 'false');
      await expect(sender.locator('#vi-resume')).toBeVisible();
      await expect(sender.locator('#vi-hold')).toBeDisabled();
      await expect(page.locator('#vi-participant-count')).toHaveText('1 person connected');
      await expect.poll(() => outputRms(page)).toBeLessThan(0.00001);
      expect(await voiceConnectionState(sender, 'inbox')).toEqual(connection);
      await sender.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        (window as any).__voiceLifecycle.setHidden(false);
      });
      expect(await attempts()).toBe(2);
      await sender.evaluate(() => (window as any).__voiceLifecycle.interrupt('unmute'));
      await expect(sender.locator('#vi-resume')).toBeHidden();
      await expect(sender.locator('#vi-hold')).toBeEnabled();
      expect(await microphoneEnabled(sender)).toBe(false);
      await expect(sender.locator('#vi-toggle')).toHaveAttribute('aria-pressed', 'false');

      await sender.locator('#vi-hold').focus();
      await sender.keyboard.down('Space');
      try {
        await expect.poll(() => microphoneEnabled(sender)).toBe(true);
        await sender.evaluate(() => (window as any).__voiceLifecycle.setHidden(true));
        expect(await microphoneEnabled(sender)).toBe(false);
        await expect(sender.locator('#vi-hold')).toHaveAttribute('aria-pressed', 'false');
      } finally {
        await sender.keyboard.up('Space');
        await sender.evaluate(() => (window as any).__voiceLifecycle.setHidden(false));
      }

      await sender.locator('#vi-toggle').click();
      await sender.evaluate(() => {
        const lifecycle = (window as any).__voiceLifecycle;
        lifecycle.interrupt('ended');
        lifecycle.setHidden(true);
        lifecycle.setHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      });
      await expect(sender.locator('#vi-resume')).toBeHidden();
      await expect.poll(() => captureAttached(sender)).toBe(true);
      expect(await attempts()).toBe(3);
      expect(await microphoneEnabled(sender)).toBe(false);
      await expect(sender.locator('#vi-toggle')).toHaveAttribute('aria-pressed', 'false');
      expect(await voiceConnectionState(sender, 'inbox')).toEqual(connection);
      expect(await voiceConnectionState(page, 'inbox')).toEqual(hostConnection);
      await expect(caller).toHaveText(callerName);
      await expect.poll(() => outputRms(page)).toBeLessThan(0.00001);
      const beforeReplacement = await receivedAudio(page);
      await sender.locator('#vi-toggle').click();
      await expect.poll(() => outputRms(page), { timeout: 20_000 }).toBeGreaterThan(0.01);
      await expect.poll(async () => (await receivedAudio(page)).packets).toBeGreaterThan(beforeReplacement.packets);

      await page.getByRole('button', { name: `Mute ${callerName}`, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      await expect(sender.locator('#vi-status-text')).toHaveText('The host muted you. Wait for the host to unmute you.');
      await expect.poll(() => microphoneEnabled(sender)).toBe(false);
      expect(await page.evaluate(() => {
        const gains: GainNode[] = (window as any).__voiceQA.gains;
        return gains.length > 0 && gains.every(gain => gain.gain.value === 0);
      })).toBe(true);
      await expect.poll(() => outputRms(page)).toBeLessThan(0.00001);
      // Replacement must retain the host's mute, including its local gain.
      await sender.evaluate(() => (window as any).__voiceLifecycle.interrupt('ended'));
      await expect(sender.locator('#vi-resume')).toBeVisible();
      await sender.locator('#vi-resume').click();
      await expect(sender.locator('#vi-resume')).toBeHidden();
      await expect.poll(() => captureAttached(sender)).toBe(true);
      expect(await attempts()).toBe(4);
      expect(await microphoneEnabled(sender)).toBe(false);
      await expect(sender.locator('#vi-hold')).toBeDisabled();
      await expect(sender.locator('#vi-status-text')).toHaveText('The host muted you. Wait for the host to unmute you.');
      expect(await voiceConnectionState(sender, 'inbox')).toEqual(connection);
      await expect.poll(() => outputRms(page)).toBeLessThan(0.00001);
      // Simulate both pages entering the page cache, including all room sockets
      // closing. The rebuilt host must restore the mute for this same caller.
      await observeProtection(page);
      await suspendVoicePage(sender); await suspendVoicePage(page);
      await peersClosed(sender); await peersClosed(page);
      await returnVoicePage(page);
      await expect(page.locator('#vi-status-text')).toHaveText('Your pager is open.', { timeout: 20_000 });
      await expect(page.locator('#vi-link')).toHaveValue(invitation);
      if (await page.locator('#vi-audio-recovery').isVisible()) await page.locator('#vi-restore-sound').click();
      await returnVoicePage(sender);
      await expect(sender.locator('#vi-status-text')).toHaveText('The host muted you. Wait for the host to unmute you.', { timeout: 20_000 });
      await expect.poll(() => page.evaluate(() => (window as any).__voiceProtectionQA.sent.some((frame: any) => frame.type === 'moderate' && frame.muted))).toBe(true);
      await expect.poll(() => captureAttached(sender)).toBe(true);
      await expect(caller).toHaveText(callerName); expect(await attempts()).toBe(5);
      expect(await microphoneEnabled(sender)).toBe(false);
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
      for (const participant of [page, sender]) await participant.evaluate(() => {
        (window as any).__voiceLifecycle.setHidden(true);
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        (window as any).__voiceLifecycle.setHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      expect(await attempts()).toBe(5);
      expect((await voiceConnectionState(sender, 'inbox')).open).toBe(0);
      expect((await voiceConnectionState(page, 'inbox')).open).toBe(0);
      expect(await page.evaluate(() => (window as any).__voiceQA.calls.length)).toBe(0);
    } finally {
      await senderContext.close();
    }
  });

  test('an anonymous caller reconnects with the same label and stays removed after reloading', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native audio transport runs in Chromium; refusal and frame checks also run in WebKit.');
    test.skip(!admitsLiveVoice(), 'The public rendezvous does not admit this test origin.');
    test.setTimeout(150_000);
    const pagerName = `QA removal ${test.info().workerIndex}-${Date.now()}`;
    const senderContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      const sender = await senderContext.newPage();
      await withoutThirdParties(sender);
      await voiceHooks(page, 'deny');
      await voiceHooks(sender, 'allow');
      await page.goto(TOOL);
      await installVoiceLifecycle(page);
      await page.locator('#vi-tab-host').click();
      await page.locator('#vi-room-name').fill(pagerName);
      await page.locator('#vi-start').click();
      await expect(page.locator('#vi-status-text')).toHaveText('Your pager is open.', { timeout: 20_000 });
      await sender.goto(await page.locator('#vi-link').inputValue());
      await installVoiceLifecycle(sender);
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
      // Lose one outbound removal, then suspend every room socket before its
      // acknowledgement deadline. Recovery must replay the retained decision.
      await observeProtection(page, true);
      await page.getByRole('button', { name: `Remove ${callerName}`, exact: true }).evaluate((button: HTMLButtonElement) => button.click());
      expect(await page.evaluate(() => (window as any).__voiceProtectionQA.dropped)).toBe(1);
      await suspendVoicePage(sender); await suspendVoicePage(page);
      await returnVoicePage(page);
      await expect(page.locator('#vi-status-text')).toHaveText('Your pager is open.', { timeout: 20_000 });
      await returnVoicePage(sender);
      await expect(sender.locator('#vi-status-text')).toHaveText('The host removed you from this pager.', { timeout: 20_000 });
      expect(await page.evaluate(() => (window as any).__voiceProtectionQA.sent.some((frame: any) => frame.type === 'kick'))).toBe(true);
      await tracksStopped(sender);
      await peersClosed(sender);
      await expect(page.locator('#vi-participants > li')).toHaveCount(0);
      await sender.reload();
      await expect(sender.locator('#vi-status-text')).toHaveText(privateDiscovery ? 'Choose an available pager or open a link from its host.' : 'Choose a nearby pager or open a link from its host.');
      await expect(sender.locator('#vi-join-form')).toBeVisible();
      const pager = privateDiscovery
        ? sender.locator('#vi-rooms .paired-nearby-row').filter({ hasText: pagerName }).getByRole('radio')
        : sender.getByRole('radio', { name: `${pagerName} Open pager`, exact: true });
      await expect(pager).toBeVisible({ timeout: DISCOVERY_TIMEOUT });
      await pager.check();
      await sender.locator('#vi-join').click();
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
