import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { canFakeCamera } from '../../lib/engine';
import { pairingMarkup } from '../../lib/offline-pairing';
import {
  tabHooks, tabBroker, prepareTabPage, selectTabPairing, startTabHost,
  noTabSockets, stoppedTab,
} from '../../lib/share-tab';

const available = discoverTools().includes('share-tab')
  && pairingMarkup('share-tab').includes('id="pairing-auto"');
const code = 'tab-abcdefghijklmnop';

// This controls the browser's hint only. Assets stay reachable; these cases do
// not claim that navigator.onLine establishes LAN reachability or an outage.
async function networkHint(context: BrowserContext, online = true) {
  await context.addInitScript((online) => {
    const state = { online }; (window as any).__tabNetworkHint = state;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online });
  }, online);
}

async function changeNetworkHint(page: Page, online: boolean) {
  await page.evaluate((online) => {
    (window as any).__tabNetworkHint.online = online;
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  }, online);
}

async function pairingMode(page: Page, mode: 'online' | 'offline') {
  await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', mode);
  await expect(page.locator('#online-viewer-fields')).toBeVisible({ visible: mode === 'online' });
  await expect(page.locator('#offline-viewer-fields')).toBeVisible({ visible: mode === 'offline' });
  await expect(page.locator('#offline-note, #offline-help').first()).toBeVisible({ visible: mode === 'offline' });
}

async function idle(page: Page) {
  expect(await page.evaluate(() => {
    const state = (window as any).__tabQA;
    return { sockets: state.sockets.length, peers: state.peers.length,
      captures: state.captures.length, userMedia: state.userMedia };
  })).toEqual({ sockets: 0, peers: 0, captures: 0, userMedia: 0 });
}

test.beforeEach(() => { test.skip(!available, 'Automatic Share Tab pairing is awaiting the website release.'); });
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) {
    expect(await page.evaluate(() => (window as any).__tabQA?.fixtureErrors ?? []), 'The controlled broker must remain healthy').toEqual([]);
  }
});

test.describe('share-tab: automatic pairing choice', () => {
  test('Automatic starts collapsed and follows idle network hints without opening a connection', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await expect(page.locator('#pairing-auto')).toBeChecked();
    await expect(page.locator('#pairing-options')).not.toHaveAttribute('open');
    await expect(page.locator('#pairing-status')).toBeHidden();
    for (const mode of ['auto', 'online', 'offline']) await expect(page.locator(`#pairing-${mode}`)).toHaveAttribute('data-no-remember');
    await pairingMode(page, 'online'); await idle(page);
    await changeNetworkHint(page, false); await pairingMode(page, 'offline');
    await expect(page.locator('#pairing-status')).toBeVisible();
    await expect(page.locator('[data-pairing-nearby]')).toBeHidden(); await idle(page);
    await changeNetworkHint(page, true); await pairingMode(page, 'online');
    await expect(page.locator('[data-pairing-nearby]')).toBeVisible(); await idle(page);
  });

  test('an offline load uses manual exchange while explicit overrides stay selected until a fresh page', async ({ page, context }) => {
    await networkHint(context, false); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await expect(page.locator('#pairing-auto')).toBeChecked(); await pairingMode(page, 'offline'); await idle(page);
    await selectTabPairing(page, 'online'); await pairingMode(page, 'online');
    await changeNetworkHint(page, true); await changeNetworkHint(page, false);
    await expect(page.locator('#pairing-online')).toBeChecked(); await pairingMode(page, 'online'); await idle(page);
    await selectTabPairing(page, 'offline'); await changeNetworkHint(page, true);
    await expect(page.locator('#pairing-offline')).toBeChecked(); await pairingMode(page, 'offline'); await idle(page);
    await page.reload();
    await expect(page.locator('#pairing-auto')).toBeChecked(); await pairingMode(page, 'offline'); await idle(page);
  });

  test('an online invitation keeps its intent under an offline hint without requesting a view', async ({ page, context }) => {
    await networkHint(context, false); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page, code);
    await pairingMode(page, 'online'); await expect(page.locator('#viewer-code')).toHaveValue(code);
    await expect(page.locator('#host-panel')).toBeHidden(); await idle(page);
    await changeNetworkHint(page, true); await changeNetworkHint(page, false);
    await pairingMode(page, 'online'); await idle(page);
    await page.locator('#show-host').click();
    await expect(page.locator('#host-panel')).toBeVisible();
    // The invitation's code remains an intentional draft until the user clears it.
    await page.locator('#viewer-code').fill(''); await changeNetworkHint(page, false);
    await pairingMode(page, 'offline'); await idle(page);
  });

  test('network hints preserve online-code and manual-block drafts without recognizing or submitting them', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#viewer-code').fill(code); await changeNetworkHint(page, false);
    await pairingMode(page, 'online'); await expect(page.locator('#viewer-code')).toHaveValue(code); await idle(page);
    await page.locator('#viewer-code').fill(''); await changeNetworkHint(page, false); await pairingMode(page, 'offline');
    const draft = 'unfinished manual connection block';
    await page.locator('#offline-offer-input').fill(draft); await changeNetworkHint(page, true);
    await pairingMode(page, 'offline'); await expect(page.locator('#offline-offer-input')).toHaveValue(draft); await idle(page);
    await page.locator('#offline-offer-input').fill(''); await changeNetworkHint(page, true);
    await pairingMode(page, 'online'); await idle(page);
  });

  test('a new invitation link takes priority over an old manual draft while an explicit Offline override remains final', async ({ page, context }) => {
    await networkHint(context, false); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    const draft = 'unfinished manual connection block';
    await page.locator('#offline-offer-input').fill(draft);
    await page.evaluate((code) => { location.hash = code; }, code);
    await pairingMode(page, 'online'); await expect(page.locator('#viewer-code')).toHaveValue(code);
    await expect(page.locator('#offline-offer-input')).toHaveValue(draft); await idle(page);
    await selectTabPairing(page, 'offline');
    const nextCode = 'tab-ponmlkjihgfedcba';
    await page.evaluate((code) => { location.hash = code; }, nextCode);
    await expect(page.locator('#viewer-code')).toHaveValue(nextCode);
    await pairingMode(page, 'offline'); await expect(page.locator('#pairing-offline')).toBeChecked(); await idle(page);
  });

  for (const online of [true, false]) test(`a pending ${online ? 'online' : 'offline'} picker keeps its method until Stop`, async ({ page, context }) => {
    await networkHint(context, online); await tabHooks(context, { capture: 'pending' }); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#host-start').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__tabQA.releaseCapture)).toBe('function');
    await changeNetworkHint(page, !online); await pairingMode(page, online ? 'online' : 'offline');
    await expect(page.locator('#pairing-status')).toBeHidden();
    for (const mode of ['auto', 'online', 'offline']) await expect(page.locator(`#pairing-${mode}`)).toBeDisabled();
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length])).toEqual([1, 0]);
    await noTabSockets(page); await page.locator('#host-stop').click();
    await pairingMode(page, online ? 'offline' : 'online');
    await expect(page.locator('#pairing-auto')).toBeEnabled();
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.tracks.length])).toEqual([1, 0]);
    await noTabSockets(page);
  });

  test('a pending viewer keeps Online and a missing room does not imply a service outage', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#viewer-code').fill(code); await page.locator('#viewer-connect').click();
    await expect(page.locator('#viewer-stop')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.sockets[0]?.readyState)).toBe(1);
    await changeNetworkHint(page, false); await pairingMode(page, 'online');
    await expect(page.locator('#pairing-status')).toBeHidden();
    await expect(page.locator('#pairing-auto')).toBeDisabled();
    await page.evaluate(() => (window as any).__tabQA.sockets[0].remoteClose(4404));
    await expect(page.locator('#viewer-stop')).toBeHidden(); await pairingMode(page, 'online');
    await expect(page.locator('#pairing-options')).not.toHaveAttribute('open');
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length,
      (window as any).__tabQA.sockets.length, (window as any).__tabQA.sockets[0].readyState])).toEqual([0, 0, 1, 3]);
  });

  test('an Automatic service failure reveals manual exchange without replying, while an Online override stays Online', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#viewer-code').fill(code); await page.locator('#viewer-connect').click();
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.sockets[0]?.readyState)).toBe(1);
    await page.evaluate(() => (window as any).__tabQA.sockets[0].emit(new Event('error')));
    await expect(page.locator('#viewer-stop')).toBeHidden(); await pairingMode(page, 'offline');
    await expect(page.locator('#pairing-options')).toHaveAttribute('open');
    await expect(page.locator('#pairing-status')).toBeVisible();
    await expect(page.locator('#offline-answer')).toHaveValue('');
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length,
      (window as any).__tabQA.sockets.length, (window as any).__tabQA.sockets[0].readyState])).toEqual([0, 0, 1, 3]);
    await changeNetworkHint(page, true);
    expect(await page.evaluate(() => (window as any).__tabQA.sockets.length)).toBe(1);
    await selectTabPairing(page, 'online'); await page.locator('#viewer-connect').click();
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.sockets[1]?.readyState)).toBe(1);
    await page.evaluate(() => (window as any).__tabQA.sockets[1].emit(new Event('error')));
    await expect(page.locator('#viewer-stop')).toBeHidden(); await pairingMode(page, 'online');
    await expect(page.locator('#pairing-online')).toBeChecked();
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length,
      (window as any).__tabQA.sockets.length])).toEqual([0, 0, 2]);
  });

  test('capture refusal leaves Automatic online instead of suggesting a service failure', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context, { capture: 'denied' }); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#host-start').click();
    await expect(page.locator('#host-status')).toContainText('cancelled or not allowed');
    await pairingMode(page, 'online'); await expect(page.locator('#pairing-auto')).toBeChecked();
    await expect(page.locator('#pairing-options')).not.toHaveAttribute('open');
    expect(await page.evaluate(() => (window as any).__tabQA.captures.length)).toBe(1); await noTabSockets(page);
  });
});

test.describe('share-tab: automatic method with native capture', () => {
  test.setTimeout(90_000);
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native canvas display capture runs in Chromium; automatic-choice and refusal checks also run in WebKit.');
    expect(await canFakeCamera(page), 'The independent native canvas capture probe must succeed').toBe(true);
  });

  for (const online of [true, false]) test(`an active ${online ? 'online' : 'offline'} host keeps its method and capture across a network hint`, async ({ page, context }) => {
    await networkHint(context, online); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#host-start').click();
    if (online) await expect(page.locator('#share-link')).toHaveValue(/#tab-[a-z2-7]{16}$/, { timeout: 20_000 });
    else await expect(page.locator('#offline-offer')).not.toHaveValue('', { timeout: 20_000 });
    await changeNetworkHint(page, !online); await pairingMode(page, online ? 'online' : 'offline');
    await expect(page.locator('#pairing-status')).toBeHidden();
    expect(await page.evaluate(() => ({ calls: (window as any).__tabQA.captures.length,
      tracks: (window as any).__tabQA.tracks.map((track: MediaStreamTrack) => track.readyState) }))).toEqual({ calls: 1, tracks: ['live'] });
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
    await pairingMode(page, online ? 'offline' : 'online');
  });

  test('service failure ends capture and manual sharing requires a fresh explicit picker attempt', async ({ page, context }) => {
    const broker = tabBroker(); await networkHint(context); await tabHooks(context); await broker.install(context);
    await startTabHost(page); await broker.failHost(page); await stoppedTab(page, true);
    await pairingMode(page, 'offline'); await expect(page.locator('#pairing-options')).toHaveAttribute('open');
    await expect(page.locator('#offline-offer')).toHaveValue('');
    await changeNetworkHint(page, true);
    expect(await page.evaluate(() => ({ calls: (window as any).__tabQA.captures.length,
      tracks: (window as any).__tabQA.tracks.map((track: MediaStreamTrack) => track.readyState),
      sockets: (window as any).__tabQA.sockets.length, peers: (window as any).__tabQA.peers.length })))
      .toEqual({ calls: 1, tracks: ['ended'], sockets: 1, peers: 0 });
    await pairingMode(page, 'offline'); await page.locator('#host-start').click();
    await expect(page.locator('#offline-offer')).not.toHaveValue('', { timeout: 20_000 });
    expect(await page.evaluate(() => {
      const state = (window as any).__tabQA;
      return { calls: state.captures.length, tracks: state.tracks.map((track: MediaStreamTrack) => track.readyState),
        freshTrack: state.tracks[0] !== state.tracks[1], sockets: state.sockets.length };
    })).toEqual({ calls: 2, tracks: ['ended', 'live'], freshTrack: true, sockets: 1 });
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });
});
