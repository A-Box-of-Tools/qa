import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { withoutThirdParties } from '../../lib/engine';
import { ETOOLBOX_DIR } from '../../lib/site';

const source = fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/share-text/src/main.js'), 'utf8');
const explicitTransport = fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/share-text/body.html'), 'utf8').includes('paired-transport.html');
const recoveredHostControls = source.includes('function hostSocket(code) {');

/** The network suite still exercises real peers. This controlled peer stops
 * at the exact stage that those traces stalled, so retry success cannot hide
 * a missing first-message deadline. No fake text goes through a WebSocket. */
async function controlledPeer(page: Page, alreadyOpen = false, holdHost = false): Promise<void> {
  await withoutThirdParties(page);
  await page.addInitScript(({ alreadyOpen, holdHost }) => {
    const state = { channel: null as any, peer: null as any, sent: [] as string[], hosts: [] as any[] };
    (window as any).__shareRecovery = state;
    class Socket {
      readyState = 1;
      onopen: any;
      onmessage: any;
      onclose: any;
      onerror: any;
      url: string;
      constructor(url: string | URL) {
        this.url = String(url);
        if (new URL(this.url).searchParams.get('role') === 'host') {
          state.hosts.push(this);
          if (holdHost) { this.readyState = 0; return; }
        }
        setTimeout(() => {
          this.open();
          this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
        }, 0);
      }
      open() { this.readyState = 1; this.onopen?.({}); }
      fail() { this.onerror?.({}); this.readyState = 3; this.onclose?.({ code: 1006 }); }
      send() {}
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3; this.onclose?.({ code: 1000 });
      }
    }
    class Channel {
      readyState = alreadyOpen ? 'open' : 'connecting';
      onopen: any;
      onmessage: any;
      onclose: any;
      binaryType = 'arraybuffer';
      send(value: string) { state.sent.push(value); }
      receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
      open() { this.readyState = 'open'; this.onopen?.({}); }
      close() { this.readyState = 'closed'; this.onclose?.({}); }
    }
    class Peer {
      localDescription: object | null = null;
      connectionState = 'connecting';
      iceConnectionState = 'checking';
      ondatachannel: any;
      onconnectionstatechange: any;
      oniceconnectionstatechange: any;
      onicecandidate: any;
      constructor() { state.peer = this; }
      createDataChannel() { state.channel = new Channel(); return state.channel; }
      async createOffer() { return { type: 'offer', sdp: 'controlled-offer' }; }
      async createAnswer() { return { type: 'answer', sdp: 'controlled-answer' }; }
      async setLocalDescription(value: object) { this.localDescription = value; }
      async setRemoteDescription() {}
      async addIceCandidate() {}
      // This fixture controls channel timing, not a real transport. An empty
      // report keeps the new route display unknown without inventing a pair.
      async getStats() { return new Map(); }
      close() {
        this.connectionState = 'closed';
        state.channel?.close();
        this.onconnectionstatechange?.({});
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: Peer });
  }, { alreadyOpen, holdHost });
}

test('share-text: recovery after an initial socket failure exposes the link and Stop, which stays terminal', async ({ page }) => {
  test.skip(!recoveredHostControls, 'This website source predates host controls being initialized on every successful socket opening.');
  await controlledPeer(page, false, true);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/share-text/');
  // Runner latency during the Stop click must not consume the queued retry's
  // five-second window. Pause before any host attempt, from a fixed baseline.
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.locator('#code').fill('qa-initial-host-retry');
  await page.locator('#private').check();
  await page.locator('#local').check();
  await page.locator('#discoverable').uncheck();
  await page.locator('#publish').click();
  await expect(page.locator('#link')).toHaveValue('');
  await expect(page.locator('#stop')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__shareRecovery.hosts.length)).toBe(1);
  await page.evaluate(() => (window as any).__shareRecovery.hosts[0].fail());
  await page.clock.fastForward(5_100);
  expect(await page.evaluate(() => (window as any).__shareRecovery.hosts.length)).toBe(2);
  const urls = await page.evaluate(() => (window as any).__shareRecovery.hosts.map((socket: any) => socket.url));
  expect(urls[1]).toBe(urls[0]);
  await page.evaluate(() => (window as any).__shareRecovery.hosts[1].open());
  const link = new URL(page.url()); link.searchParams.set('local', '1'); if (explicitTransport) link.searchParams.set('transport', 'direct'); link.hash = 'qa-initial-host-retry';
  await expect(page.locator('#link')).toHaveValue(link.href);
  await expect(page.locator('#linkrow')).toBeVisible();
  await expect(page.locator('#stop')).toBeVisible();
  await expect(page.locator('#publish')).toBeHidden();
  await expect(page.locator('#private')).toBeChecked();
  await expect(page.locator('#local')).toBeChecked();
  expect(await page.evaluate(() => (window as any).__shareRecovery.peer)).toBeNull();

  // Stop must cancel a queued retry and fence an already-queued old open event.
  await page.evaluate(() => {
    const state = (window as any).__shareRecovery;
    state.lateOpen = state.hosts[1].onopen;
    state.hosts[1].fail();
  });
  await page.locator('#stop').click();
  await page.evaluate(() => {
    (window as any).__shareRecovery.lateOpen({});
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('online'));
  });
  await page.clock.fastForward(60_100);
  await expect(page.locator('#publish')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('#linkrow')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__shareRecovery.hosts.map((socket: any) => socket.readyState))).toEqual([3, 3]);
  expect(await page.evaluate(() => (window as any).__shareRecovery.peer)).toBeNull();
});

test('share-text: an open channel without its first message ends with a fresh retry', async ({ page }) => {
  await controlledPeer(page);
  await page.clock.install();
  await page.goto('/share-text/#qa-controlled');
  await page.locator('#connect').click();
  await page.evaluate(() => (window as any).__shareRecovery.channel.open());
  await expect(page.locator('#view-status')).toContainText('Waiting for the sharer');
  expect(await page.evaluate(() => (window as any).__shareRecovery.sent)).toContain('{"type":"hello"}');
  await page.clock.fastForward(20_100);
  await expect(page.locator('#view-status')).toContainText('the share did not arrive');
  await expect(page.locator('#retry')).toBeVisible();
  await expect(page.locator('#relayrow')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__shareRecovery.peer.connectionState)).toBe('closed');
  // A late frame from the retired attempt must not replace the failure UI.
  await page.evaluate(() => (window as any).__shareRecovery.channel.receive({ type: 'text', body: 'late retired text' }));
  await expect(page.locator('#panel')).toBeHidden();
  await page.locator('#retry').click();
  await expect(page.locator('#consent')).toBeVisible();
});

test('share-text: an already-open channel receives text without waiting for an open event', async ({ page }) => {
  await controlledPeer(page, true);
  await page.clock.install();
  await page.goto('/share-text/#qa-controlled');
  await page.locator('#connect').click();
  expect(await page.evaluate(() => (window as any).__shareRecovery.sent)).toContain('{"type":"hello"}');
  await page.evaluate(() => (window as any).__shareRecovery.channel.receive({ type: 'text', body: 'ready text' }));
  await expect(page.locator('#panel')).toContainText('ready text');
  await page.clock.fastForward(40_100);
  await expect(page.locator('#panel')).toContainText('ready text');
  await expect(page.locator('#retry')).toBeHidden();
});

test('share-text: a delivered private introduction waits for human admission without timing out', async ({ page }) => {
  await controlledPeer(page);
  await page.clock.install();
  await page.goto('/share-text/#qa-controlled');
  await page.locator('#connect').click();
  await page.evaluate(() => {
    const channel = (window as any).__shareRecovery.channel;
    channel.open();
    channel.receive({ type: 'private' });
  });
  await page.clock.fastForward(60_100);
  await expect(page.locator('#knockrow')).toBeVisible();
  await expect(page.locator('#retry')).toBeHidden();
  await page.locator('#knock').fill('Waiting reader');
  await page.locator('#send-knock').click();
  await page.evaluate(() => (window as any).__shareRecovery.channel.receive({ type: 'text', body: 'admitted text' }));
  await expect(page.locator('#panel')).toContainText('admitted text');
});

test('share-text: a peer that never opens keeps Direct mode and offers a fresh retry', async ({ page }) => {
  await controlledPeer(page);
  await page.clock.install();
  await page.goto('/share-text/#qa-controlled');
  await page.locator('#connect').click();
  await page.clock.fastForward(20_100);
  await expect(page.locator('#view-status')).toContainText('Could not reach the sharer directly');
  await expect(page.locator('#retry')).toBeVisible();
  if (explicitTransport) {
    await expect(page.locator('#relayrow')).toBeHidden();
    await expect(page.locator('#relay')).toHaveCount(0);
    await expect(page.locator('#pairing-transport')).toHaveValue('direct');
    await page.locator('#retry').click();
    await expect(page.locator('#consent')).toBeVisible();
    await expect(page.locator('#pairing-transport')).toHaveValue('direct');
  } else {
    await expect(page.locator('#relayrow')).toBeVisible();
  }
});

test('share-text: a local peer that never opens times out without a relay and can retry', async ({ page }) => {
  await controlledPeer(page);
  await page.clock.install();
  await page.goto('/share-text/?local=1#qa-controlled');
  await page.locator('#connect').click();
  await page.evaluate(() => {
    const peer = (window as any).__shareRecovery.peer;
    peer.iceConnectionState = 'new';
    peer.connectionState = 'new';
  });
  await page.clock.fastForward(20_100);
  await expect(page.locator('#view-status')).toContainText('Could not reach the sharer in Local network mode');
  await expect(page.locator('#retry')).toBeVisible();
  await expect(page.locator('#relayrow')).toBeHidden();
  await expect(page.locator('#panel')).toBeHidden();
  expect(await page.evaluate(() => (window as any).__shareRecovery.peer.connectionState)).toBe('closed');
  await page.locator('#retry').click();
  expect(new URL(page.url()).searchParams.getAll('local')).toEqual(['1']);
  await expect(page.locator('#consent')).toBeVisible();
  await page.locator('#connect').click();
  await page.evaluate(() => {
    const channel = (window as any).__shareRecovery.channel;
    channel.open();
    channel.receive({ type: 'text', body: 'local retry arrived' });
  });
  await expect(page.locator('#panel')).toContainText('local retry arrived');
  await expect(page.locator('#relayrow')).toBeHidden();
  await expect(page.locator('#retry')).toBeHidden();
});

test('share-text: an old carried admission token can wait for a new human decision', async ({ page }) => {
  await controlledPeer(page);
  await page.addInitScript(() => {
    sessionStorage.setItem('share-text-carry:qa-controlled', String(Date.now()));
    sessionStorage.setItem('share-text-token:qa-controlled', 'previous-share-token');
  });
  await page.clock.install();
  await page.goto('/share-text/#qa-controlled');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__shareRecovery.channel))).toBe(true);
  await page.evaluate(() => {
    const channel = (window as any).__shareRecovery.channel;
    channel.open();
    channel.receive({ type: 'private' });
    channel.receive({ type: 'asked' });
  });
  expect(await page.evaluate(() => (window as any).__shareRecovery.sent))
    .toContain('{"type":"knock","note":"","token":"previous-share-token"}');
  await page.clock.fastForward(60_100);
  await expect(page.locator('#view-status')).toContainText('Waiting for the sharer to let you in');
  await expect(page.locator('#retry')).toBeHidden();
  await page.evaluate(() => (window as any).__shareRecovery.channel.receive({ type: 'text', body: 'newly admitted' }));
  await expect(page.locator('#panel')).toContainText('newly admitted');
});
