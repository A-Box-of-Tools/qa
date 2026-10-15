import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { discoverTools } from '../../lib/tools';
import { BASE_URL } from '../../lib/site';
import { canFakeCamera } from '../../lib/engine';
import { liveRendezvous } from '../../lib/rendezvous';
import {
  tabHooks, tabBroker, prepareTabPage, startTabHost, requestTab, requestRow,
  startOfflineTabHost, replyOfflineTab, localTabOnly, noTabSockets,
  noTabMedia, flowingTab, stoppedTab, type CaptureMode,
} from '../../lib/share-tab';

const TOOL = '/share-tab/';
const exists = discoverTools().includes(TOOL.slice(1, -1));

async function foreground(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    window.dispatchEvent(new Event('online'));
  });
}

async function approve(host: Page, viewer: Page, note: string) {
  const row = requestRow(host, note);
  await expect(row.locator('[data-action="host.approve"]')).toBeVisible({ timeout: 20_000 });
  await row.locator('[data-action="host.approve"]').click();
  await flowingTab(viewer);
}

async function directFailure(viewer: Page) {
  await expect.poll(() => viewer.evaluate(() => (window as any).__tabQA.peers.length)).toBe(1);
  await viewer.evaluate(() => {
    const peer = (window as any).__tabQA.peers[0] as RTCPeerConnection;
    // A controlled lifecycle fault, not evidence that the runner's network failed.
    Object.defineProperty(peer, 'connectionState', { configurable: true, get: () => 'failed' });
    peer.dispatchEvent(new Event('connectionstatechange'));
  });
  await expect(viewer.locator('#viewer-status')).toContainText('There is no internet relay');
  expect(await viewer.evaluate(() => (window as any).__tabQA.peers[0].signalingState)).toBe('closed');
}

test.afterEach(async ({ context }) => {
  for (const page of context.pages()) {
    expect(await page.evaluate(() => (window as any).__tabQA?.fixtureErrors ?? []), 'The controlled broker itself must remain healthy').toEqual([]);
  }
});

test.describe('share-tab: picker and terminal intent', () => {
  test.beforeEach(() => { test.skip(!exists, 'Share a Browser Tab is awaiting the website release.'); });

  for (const mode of ['denied', 'cancelled', 'window', 'monitor', 'unknown'] as CaptureMode[]) {
    test(`a ${mode} picker result publishes no invitation or connection`, async ({ page, context }) => {
      if (['window', 'monitor', 'unknown'].includes(mode)) {
        test.skip(!await page.evaluate(() => typeof HTMLCanvasElement.prototype.captureStream === 'function'),
          'This engine has no independent native canvas track for the supplied picker result.');
      }
      await tabHooks(context, { capture: mode });
      await tabBroker().install(context);
      await prepareTabPage(page);
      await page.locator('#host-start').click();
      await expect(page.locator('#host-status')).toContainText(mode === 'denied' ? 'cancelled or not allowed'
        : mode === 'cancelled' ? 'attempt was stopped' : 'rather than a window or screen');
      await expect(page.locator('#host-invitation')).toBeHidden();
      await expect(page.locator('#host-preview-panel')).toBeHidden();
      expect(await page.evaluate(() => {
        const state = (window as any).__tabQA;
        return { calls: state.captures.length, audio: state.captures[0].audio,
          sockets: state.sockets.length, peers: state.peers.length,
          stopped: state.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended') };
      })).toEqual({ calls: 1, audio: false, sockets: 0, peers: 0, stopped: true });
      await foreground(page);
      expect(await page.evaluate(() => (window as any).__tabQA.captures.length)).toBe(1);
    });
  }

  for (const offline of [false, true]) test(`Stop retires a pending ${offline ? 'offline' : 'online'} picker and closes its late grant without recapturing`, async ({ page, context }) => {
    test.skip(!await page.evaluate(() => typeof HTMLCanvasElement.prototype.captureStream === 'function'),
      'This engine has no independent native canvas track for the supplied picker result.');
    await tabHooks(context, { capture: 'pending' }); await tabBroker().install(context);
    await prepareTabPage(page);
    if (offline) await page.locator('#pairing-offline').check();
    await page.locator('#host-start').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__tabQA.releaseCapture)).toBe('function');
    await page.locator('#host-stop').click();
    await expect(page.locator('#host-stop')).toBeHidden();
    await page.evaluate(() => (window as any).__tabQA.releaseCapture());
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.tracks.length)).toBe(1);
    await stoppedTab(page, true); await foreground(page);
    expect(await page.evaluate(() => {
      const state = (window as any).__tabQA;
      return { captures: state.captures.length, sockets: state.sockets.length, peers: state.peers.length };
    })).toEqual({ captures: 1, sockets: 0, peers: 0 });
    await expect(page.locator('#host-status')).toContainText('Sharing stopped');
  });

  test('a browser without display capture still offers viewing controls', async ({ page }) => {
    await page.addInitScript(() => {
      const media = navigator.mediaDevices;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media ? new Proxy(media, {
        get(target, property) {
          if (property === 'getDisplayMedia') return undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) : {} });
    });
    await prepareTabPage(page);
    await expect(page.locator('#host-start')).toBeDisabled();
    await expect(page.locator('#capture-support')).toContainText('You can still watch');
    await expect(page.locator('#viewer-connect')).toBeEnabled();
  });
});

test.describe('share-tab: native pairing, approval and live video', () => {
  test.setTimeout(90_000);
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(!exists, 'Share a Browser Tab is awaiting the website release.');
    test.skip(browserName !== 'chromium',
      'This harness supplies flowing native canvas display tracks in Chromium. Real Safari picker and video remain physical acceptance checks.');
    // An independent fixture probe must fail visibly on the engine this suite
    // promises to exercise; a tool's failure never becomes a capability skip.
    expect(await canFakeCamera(page), 'The independent native canvas fixture must paint before testing Share Tab').toBe(true);
  });

  test('an invitation is idle until Request, and approval plus ACK precede native video', async ({ page, context }) => {
    const broker = tabBroker({ privateNotes: ['ACK boundary viewer'] }); await tabHooks(context, { holdAck: true }); await broker.install(context);
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await prepareTabPage(viewer, code);
    expect(new URL(viewer.url()).pathname).toBe(TOOL);
    expect(await viewer.evaluate(() => {
      const state = (window as any).__tabQA;
      return [state.captures.length, state.userMedia, state.sockets.length, state.peers.length];
    })).toEqual([0, 0, 0, 0]);
    await viewer.locator('#viewer-name').fill('ACK boundary viewer');
    await viewer.locator('#viewer-connect').click();
    const row = requestRow(page, 'ACK boundary viewer');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await noTabMedia(page, viewer);
    expect(broker.observed.descriptions.filter((item) => item.type === 'offer').map((item) => item.media)).toEqual([['application']]);
    await row.locator('[data-action="host.approve"]').click();
    await expect.poll(() => viewer.evaluate(() => (window as any).__tabQA.ackHeld)).toBe(true);
    await expect(page.locator('#accepted-viewers')).toContainText('Waiting for video');
    await noTabMedia(page, viewer);
    expect(broker.observed.descriptions.filter((item) => item.type === 'offer')).toHaveLength(1);
    await viewer.evaluate(() => (window as any).__tabQA.releaseAck());
    await flowingTab(viewer);
    await expect(page.locator('#accepted-viewers')).toContainText('Watching');
    expect(await page.evaluate(() => {
      const state = (window as any).__tabQA;
      return { kinds: state.peers[0].getSenders().map((sender: RTCRtpSender) => sender.track?.kind).filter(Boolean),
        audio: state.captures[0].audio, userMedia: state.userMedia,
        iceServers: state.peers[0].getConfiguration().iceServers };
    })).toEqual({ kinds: ['video'], audio: false, userMedia: 0, iceServers: [] });
    await localTabOnly(page, viewer);
    expect(await viewer.evaluate(() => (window as any).__tabQA.peers[0].getSenders().every((sender: RTCRtpSender) => !sender.track))).toBe(true);
    expect(broker.observed.relayRequests).toBe(0);
    expect(broker.observed.noteLeaked).toBe(false);
    expect(broker.observed.urls.every((address) => new URL(address).searchParams.get('tool') === 'share-tab')).toBe(true);
    await page.locator('#host-stop').click();
    await stoppedTab(page, true); await stoppedTab(viewer);
    await foreground(page); await foreground(viewer);
    expect(await page.evaluate(() => (window as any).__tabQA.captures.length)).toBe(1);
    expect(await viewer.evaluate(() => (window as any).__tabQA.captures.length)).toBe(0);
  });

  test('a native remote hello arriving before the local open callback still sends hello before request', async ({ page, context }) => {
    await tabHooks(context, { deferLocalOpen: true }); await tabBroker().install(context);
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await requestTab(viewer, code, 'Open callback ordering');
    await expect(requestRow(page, 'Open callback ordering')).toBeVisible({ timeout: 20_000 });
    expect(await viewer.evaluate(() => (window as any).__tabQA.controls.slice(0, 2).map((item: any) => item.type))).toEqual(['hello', 'request']);
    expect(await viewer.evaluate(() => (window as any).__tabQA.delayedOpenReplayed)).toBe(1);
    expect(await viewer.evaluate(() => (window as any).__tabQA.controls.filter((item: any) => item.type === 'hello').length)).toBe(1);
    await approve(page, viewer, 'Open callback ordering');
    await page.locator('#host-stop').click(); await stoppedTab(viewer); await stoppedTab(page, true);
  });

  test('pending viewers remain private, denial is terminal, and changing the sole viewer needs fresh approval', async ({ page, context }) => {
    await tabHooks(context); await tabBroker().install(context);
    const { code } = await startTabHost(page);
    const first = await context.newPage(), second = await context.newPage(), denied = await context.newPage();
    await requestTab(first, code, 'First viewer'); await requestTab(second, code, 'Later viewer');
    await requestTab(denied, code, 'Turned away viewer');
    await expect(page.locator('#viewer-requests li')).toHaveCount(3, { timeout: 20_000 });
    await noTabMedia(page, first); await noTabMedia(page, second); await noTabMedia(page, denied);
    await requestRow(page, 'Turned away viewer').locator('[data-action="host.deny"]').click();
    await expect(denied.locator('#viewer-status')).toContainText('turned away'); await stoppedTab(denied);
    await foreground(denied);
    expect(await denied.evaluate(() => (window as any).__tabQA.sockets.length)).toBe(1);
    await approve(page, first, 'First viewer');
    await expect(requestRow(page, 'Later viewer').locator('[data-action="host.approve"]')).toBeDisabled();
    expect(await second.evaluate(() => (window as any).__tabQA.received.length)).toBe(0);
    const extra = await context.newPage(); await requestTab(extra, code, 'Already occupied');
    await expect(extra.locator('#viewer-status')).toContainText('already watching'); await stoppedTab(extra);
    await page.locator('[data-action="host.disconnect"]').click(); await stoppedTab(first);
    await expect(requestRow(page, 'Later viewer').locator('[data-action="host.approve"]')).toBeEnabled();
    expect(await second.evaluate(() => (window as any).__tabQA.received.length)).toBe(0);
    await approve(page, second, 'Later viewer');
    await second.locator('#viewer-stop').click(); await stoppedTab(second);
    await expect(page.locator('#accepted-panel')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__tabQA.tracks.every((track: MediaStreamTrack) => track.readyState === 'live'))).toBe(true);
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });

  test('four requests can wait, the fifth is refused without media, and Stop closes every attempt', async ({ page, context }) => {
    await tabHooks(context); await tabBroker().install(context);
    const { code } = await startTabHost(page), viewers: Page[] = [];
    for (let index = 0; index < 5; index++) {
      const viewer = await context.newPage(); viewers.push(viewer); await requestTab(viewer, code, `Pending ${index + 1}`);
      if (index < 4) await expect(requestRow(page, `Pending ${index + 1}`)).toBeVisible({ timeout: 20_000 });
    }
    await expect(page.locator('#viewer-requests li')).toHaveCount(4);
    await expect(viewers[4].locator('#viewer-status')).toContainText('too many requests');
    for (const viewer of viewers) await noTabMedia(page, viewer);
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
    for (const viewer of viewers) await stoppedTab(viewer);
  });

  test('a healthy hidden host keeps its stream, but capture ending retires it without automatic recapture', async ({ page, context }) => {
    await tabHooks(context); await tabBroker().install(context);
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await requestTab(viewer, code, 'Lifecycle viewer'); await approve(page, viewer, 'Lifecycle viewer');
    await page.evaluate(() => {
      const state = (window as any).__tabQA; state.originalPeer = state.peers[0]; state.originalTrack = state.tracks[0];
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flowingTab(viewer);
    expect(await page.evaluate(() => {
      const state = (window as any).__tabQA;
      return state.captures.length === 1 && state.peers.length === 1 && state.peers[0] === state.originalPeer
        && state.tracks[0] === state.originalTrack && state.originalTrack.readyState === 'live';
    })).toBe(true);
    await page.evaluate(() => {
      const track = (window as any).__tabQA.tracks[0] as MediaStreamTrack;
      track.stop(); track.dispatchEvent(new Event('ended'));
    });
    await stoppedTab(page, true); await stoppedTab(viewer);
    await foreground(page); await foreground(viewer);
    await expect(page.locator('#host-status')).toContainText('Tab sharing ended');
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.sockets.length])).toEqual([1, 1]);
    await page.locator('#host-start').click();
    await expect(page.locator('#share-link')).toHaveValue(/#tab-[a-z2-7]{16}$/);
    expect(new URL(await page.locator('#share-link').inputValue()).hash.slice(1)).not.toBe(code);
    expect(await page.evaluate(() => (window as any).__tabQA.captures.length)).toBe(2);
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });

  test('unsupported input commands end the peer instead of providing remote control', async ({ page, context }) => {
    await tabHooks(context); await tabBroker().install(context);
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await requestTab(viewer, code, 'Read only viewer'); await approve(page, viewer, 'Read only viewer');
    expect(await viewer.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.userMedia])).toEqual([0, 0]);
    await viewer.evaluate(() => (window as any).__tabQA.channels[0].send(JSON.stringify({ protocol: 'share-tab-v1', type: 'pointer', x: 10, y: 10 })));
    await stoppedTab(viewer);
    await expect(page.locator('#accepted-panel')).toBeHidden();
    expect(await page.evaluate(() => (window as any).__tabQA.tracks[0].readyState)).toBe('live');
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });

  test('local connection failure stays terminal without address discovery or an internet relay', async ({ page, context }) => {
    const broker = tabBroker({ holdDescriptions: true }); await tabHooks(context); await broker.install(context);
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await requestTab(viewer, code, 'Local connection failure'); await directFailure(viewer);
    await foreground(viewer);
    expect(await viewer.evaluate(() => {
      const state = (window as any).__tabQA;
      return { peers: state.peers.length, servers: state.peers[0].getConfiguration().iceServers,
        received: state.received.length, captures: state.captures.length, sockets: state.sockets.length };
    })).toEqual({ peers: 1, servers: [], received: 0, captures: 0, sockets: 1 });
    await expect(viewer.locator('#viewer-relay, #relay-panel')).toHaveCount(0);
    expect(broker.observed.relayRequests).toBe(0);
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });

  test('non-host candidates in SDP and trickle are filtered while native local video still flows', async ({ page, context }) => {
    const broker = tabBroker({ injectNonHostCandidates: true }); await tabHooks(context); await broker.install(context);
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await requestTab(viewer, code, 'Host candidates only');
    await approve(page, viewer, 'Host candidates only');
    await localTabOnly(page, viewer);
    expect(broker.observed.injectedCandidates).toBeGreaterThanOrEqual(8);
    expect(broker.observed.candidates.length).toBeGreaterThan(0);
    expect(broker.observed.candidates.every((type) => type === 'host')).toBe(true);
    expect(broker.observed.relayRequests).toBe(0);
    await page.locator('#host-stop').click(); await stoppedTab(viewer); await stoppedTab(page, true);
  });

  test('offline block exchange still needs approval plus ACK before native video and Stop retires the exchange', async ({ page, context }) => {
    await tabHooks(context, { holdAck: true, live: true });
    const offer = await startOfflineTabHost(page), viewer = await context.newPage();
    const answer = await replyOfflineTab(viewer, offer, 'Offline approval boundary');
    for (const block of [offer, answer]) {
      const parsed = JSON.parse(block);
      expect(parsed.format).toBe('share-tab-offline-v1');
      expect(parsed.description.sdp.match(/^m=\w+/gm)).toEqual(['m=application']);
      expect([...parsed.description.sdp.matchAll(/^a=candidate:[^\r\n]*\styp\s+(\w+)/gm)].map((match: RegExpMatchArray) => match[1]))
        .toEqual(expect.arrayContaining(['host']));
    }
    await noTabMedia(page, viewer); await noTabSockets(page, viewer);
    await page.locator('#offline-answer-input').fill(answer); await page.locator('#offline-accept').click();
    const row = requestRow(page, 'Offline approval boundary'); await expect(row).toBeVisible({ timeout: 20_000 });
    await noTabMedia(page, viewer);
    await row.locator('[data-action="host.approve"]').click();
    await expect.poll(() => viewer.evaluate(() => (window as any).__tabQA.ackHeld)).toBe(true);
    await noTabMedia(page, viewer);
    await viewer.evaluate(() => (window as any).__tabQA.releaseAck());
    await flowingTab(viewer); await localTabOnly(page, viewer); await noTabSockets(page, viewer);
    await expect(page.locator('#offline-accept')).toBeDisabled();
    expect(await viewer.evaluate(() => (window as any).__tabQA.peers[0].getSenders().every((sender: RTCRtpSender) => !sender.track))).toBe(true);
    await page.locator('#host-stop').click(); await stoppedTab(page, true); await stoppedTab(viewer);
    await foreground(page); await foreground(viewer); await noTabSockets(page, viewer);
    await expect(page.locator('#offline-offer')).toHaveValue('');
    await expect(page.locator('#offline-answer-input')).toHaveValue('');
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length])).toEqual([1, 1]);
    expect(await viewer.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length])).toEqual([0, 1]);
  });

  test('offline host and reply files round-trip complete native blocks without a WebSocket', async ({ page, context }) => {
    await tabHooks(context, { live: true });
    const offer = await startOfflineTabHost(page), viewer = await context.newPage();
    const hostDownload = page.waitForEvent('download'); await page.locator('#save-offer').click();
    const offerFile = await hostDownload; expect(offerFile.suggestedFilename()).toBe('tab-offer.json');
    const offerBytes = await readFile((await offerFile.path())!); expect(offerBytes.toString('utf8')).toBe(offer);
    await prepareTabPage(viewer); await viewer.locator('#pairing-offline').check();
    const offerChooser = viewer.waitForEvent('filechooser'); await viewer.locator('#choose-offer').click();
    await (await offerChooser).setFiles({ name: 'tab-offer.json', mimeType: 'application/json', buffer: offerBytes });
    await expect(viewer.locator('#offline-offer-input')).toHaveValue(offer);
    await viewer.locator('#viewer-name').fill('Offline file viewer'); await viewer.locator('#offline-reply').click();
    await expect(viewer.locator('#offline-answer')).not.toHaveValue('', { timeout: 20_000 });
    const answer = await viewer.locator('#offline-answer').inputValue();
    const replyDownload = viewer.waitForEvent('download'); await viewer.locator('#save-answer').click();
    const answerFile = await replyDownload; expect(answerFile.suggestedFilename()).toBe('tab-answer.json');
    const answerBytes = await readFile((await answerFile.path())!); expect(answerBytes.toString('utf8')).toBe(answer);
    const answerChooser = page.waitForEvent('filechooser'); await page.locator('#choose-answer').click();
    await (await answerChooser).setFiles({ name: 'tab-answer.json', mimeType: 'application/json', buffer: answerBytes });
    await expect(page.locator('#offline-answer-input')).toHaveValue(answer);
    await page.locator('#offline-accept').click(); await noTabMedia(page, viewer);
    await approve(page, viewer, 'Offline file viewer'); await localTabOnly(page, viewer); await noTabSockets(page, viewer);
    await viewer.locator('#viewer-stop').click(); await stoppedTab(viewer);
    await expect(page.locator('#host-stop')).toBeHidden(); await stoppedTab(page, true);
    await foreground(page); await foreground(viewer); await noTabSockets(page, viewer);
  });

  test('invalid, mismatched and retired offline blocks never grant viewing consent', async ({ page, context }) => {
    await tabHooks(context, { live: true });
    const offer = await startOfflineTabHost(page), viewer = await context.newPage();
    await prepareTabPage(viewer); await viewer.locator('#pairing-offline').check();
    for (const invalid of ['not-json', JSON.stringify({ format: 'share-tab-offline-v1' })]) {
      await viewer.locator('#offline-offer-input').fill(invalid); await viewer.locator('#offline-reply').click();
      await expect(viewer.locator('#viewer-status')).toContainText('host block is incomplete or unsupported');
      expect(await viewer.evaluate(() => [(window as any).__tabQA.peers.length, (window as any).__tabQA.captures.length])).toEqual([0, 0]);
    }
    const answer = await replyOfflineTab(viewer, offer, 'Unapproved offline viewer');
    const mismatch = JSON.parse(answer); mismatch.session = mismatch.session === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32);
    for (const invalid of ['not-json', offer, JSON.stringify(mismatch)]) {
      await page.locator('#offline-answer-input').fill(invalid); await page.locator('#offline-accept').click();
      await expect(page.locator('#offline-accept-status')).toContainText('reply does not match this connection');
      await expect(page.locator('#offline-accept')).toBeEnabled();
      await expect(page.locator('#viewer-requests li')).toHaveCount(0); await noTabMedia(page, viewer);
    }
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
    await page.locator('#host-start').click(); await expect(page.locator('#offline-offer')).not.toHaveValue('', { timeout: 20_000 });
    expect(JSON.parse(await page.locator('#offline-offer').inputValue()).session).not.toBe(JSON.parse(offer).session);
    await page.locator('#offline-answer-input').fill(answer); await page.locator('#offline-accept').click();
    await expect(page.locator('#offline-accept-status')).toContainText('reply does not match this connection');
    await noTabMedia(page, viewer); await noTabSockets(page, viewer);
    await page.locator('#host-stop').click(); await viewer.locator('#viewer-stop').click();
    await stoppedTab(page, true); await stoppedTab(viewer);
  });

  test('an offline reply accepted after the host deadline is refused without media', async ({ page, context }) => {
    await tabHooks(context, { live: true });
    const offer = await startOfflineTabHost(page), viewer = await context.newPage();
    const answer = await replyOfflineTab(viewer, offer, 'Expired offline viewer');
    await page.evaluate((expires) => { Date.now = () => expires + 1; }, JSON.parse(offer).expires);
    await page.locator('#offline-answer-input').fill(answer); await page.locator('#offline-accept').click();
    await expect(page.locator('#offline-accept-status')).toContainText('expired');
    await expect(page.locator('#viewer-requests li')).toHaveCount(0);
    await noTabMedia(page, viewer); await noTabSockets(page, viewer);
    await page.locator('#host-stop').click(); await viewer.locator('#viewer-stop').click();
    await stoppedTab(page, true); await stoppedTab(viewer);
  });

  test('the live rendezvous admits the Share Tab namespace and carries setup while native video advances', async ({ page, context }) => {
    const endpoint = liveRendezvous('tools/share-tab/src/session.js');
    const host = new URL(BASE_URL).hostname;
    expect(host === 'localhost' || host === '127.0.0.1' || host === 'abox.tools' || host.endsWith('.abox-preview.pages.dev'),
      'The live worker smoke requires an admitted HTTPS preview or loopback origin').toBe(true);
    await tabHooks(context, { live: true });
    const { code } = await startTabHost(page), viewer = await context.newPage();
    await page.evaluate(() => { (window as any).__tabQA.note = 'Live namespace private note'; });
    await requestTab(viewer, code, 'Live namespace private note');
    await expect(requestRow(page, 'Live namespace private note')).toBeVisible({ timeout: 20_000 });
    await noTabMedia(page, viewer);
    await approve(page, viewer, 'Live namespace private note');
    for (const side of [page, viewer]) {
      expect(await side.evaluate(() => (window as any).__tabQA.sockets.map((socket: WebSocket) => {
        const url = new URL(socket.url); return { origin: url.origin, tool: url.searchParams.get('tool'), path: url.pathname.startsWith('/ws/tab-') };
      }))).toEqual([{ origin: endpoint, tool: 'share-tab', path: true }]);
      expect(await side.evaluate(() => (window as any).__tabQA.signals.some((item: any) => item.noteLeaked || item.relay))).toBe(false);
    }
    await localTabOnly(page, viewer);
    await viewer.locator('#viewer-stop').click(); await stoppedTab(viewer);
    await expect(page.locator('#accepted-panel')).toBeHidden();
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });
});
