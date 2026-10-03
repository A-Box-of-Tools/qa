import { test, expect, type Page } from '@playwright/test';
import { withoutThirdParties } from '../../lib/engine';

/** The network suite still exercises real peers. This controlled peer stops
 * at the exact stage that those traces stalled, so retry success cannot hide
 * a missing first-message deadline. No fake text goes through a WebSocket. */
async function controlledPeer(page: Page, alreadyOpen = false): Promise<void> {
  await withoutThirdParties(page);
  await page.addInitScript(({ alreadyOpen }) => {
    const state = { channel: null as any, peer: null as any, sent: [] as string[] };
    (window as any).__shareRecovery = state;
    class Socket {
      readyState = 1;
      onopen: any;
      onmessage: any;
      onclose: any;
      constructor() {
        setTimeout(() => {
          this.onopen?.({});
          this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
        }, 0);
      }
      send() {}
      close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
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
      close() {
        this.connectionState = 'closed';
        state.channel?.close();
        this.onconnectionstatechange?.({});
      }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: Peer });
  }, { alreadyOpen });
}

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

test('share-text: a peer that never opens offers the direct-connection failure and optional relay', async ({ page }) => {
  await controlledPeer(page);
  await page.clock.install();
  await page.goto('/share-text/#qa-controlled');
  await page.locator('#connect').click();
  await page.clock.fastForward(20_100);
  await expect(page.locator('#view-status')).toContainText('Could not reach the sharer directly');
  await expect(page.locator('#retry')).toBeVisible();
  await expect(page.locator('#relayrow')).toBeVisible();
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
