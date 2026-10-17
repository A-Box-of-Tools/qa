import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR, onProductionDomain } from '../../lib/site';
import { canFakeCamera } from '../../lib/engine';
import { tabHooks, tabBroker, prepareTabPage, startTabHost, noTabSockets, stoppedTab } from '../../lib/share-tab';

const source = path.join(ETOOLBOX_DIR, 'tools/share-tab/body.html');
const body = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : '';
const site = fs.readFileSync(path.join(ETOOLBOX_DIR, 'config/site.toml'), 'utf8');
const awaitingProduction = onProductionDomain() && (!body || /pairing-options|offline-offer-input/.test(body)
  || !/^pairing_cached\s*=/m.test(site));
const code = 'tab-abcdefghijklmnop';

async function networkHint(context: BrowserContext, online = true) {
  await context.addInitScript(online => {
    const state = (window as any).__tabNetworkHint = { online };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online });
  }, online);
}

async function changeNetworkHint(page: Page, online: boolean) {
  await page.evaluate(online => {
    (window as any).__tabNetworkHint.online = online;
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  }, online);
  await expect(page.locator('#pairing-options, #offline-offer-input, #offline-answer')).toHaveCount(0);
}

async function idle(page: Page) {
  expect(await page.evaluate(() => {
    const state = (window as any).__tabQA;
    return { sockets: state.sockets.length, peers: state.peers.length,
      captures: state.captures.length, userMedia: state.userMedia };
  })).toEqual({ sockets: 0, peers: 0, captures: 0, userMedia: 0 });
}

test.beforeEach(() => test.skip(awaitingProduction, 'Simplified Share Tab pairing is awaiting the website release.'));
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) expect(await page.evaluate(() => (window as any).__tabQA?.fixtureErrors ?? [])).toEqual([]);
});

test.describe('share-tab: network hints preserve explicit intent', () => {
  test('an invitation and a typed code remain idle when the network hint changes', async ({ page, context }) => {
    await networkHint(context, false); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page, code);
    await expect(page.locator('#viewer-code')).toHaveValue(code); await expect(page.locator('#host-panel')).toBeHidden(); await idle(page);
    await changeNetworkHint(page, true); await changeNetworkHint(page, false);
    await expect(page.locator('#viewer-code')).toHaveValue(code); await idle(page);
    await page.locator('#show-host').click(); await expect(page.locator('#host-panel')).toBeVisible();
    const draft = 'tab-ponmlkjihgfedcba'; await page.locator('#viewer-code').fill(draft);
    await changeNetworkHint(page, true); await expect(page.locator('#viewer-code')).toHaveValue(draft); await idle(page);
  });

  test('a pending picker is not repeated or replaced by a changed network hint', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context, { capture: 'pending' }); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#host-start').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__tabQA.releaseCapture)).toBe('function');
    await changeNetworkHint(page, false);
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length])).toEqual([1, 0]);
    await noTabSockets(page); await page.locator('#host-stop').click(); await changeNetworkHint(page, true);
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.tracks.length])).toEqual([1, 0]);
    await noTabSockets(page);
  });

  test('a missing room ends a pending viewer without capture, retry or alternate connection controls', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#viewer-code').fill(code); await page.locator('#viewer-connect').click();
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.sockets[0]?.readyState)).toBe(1);
    await changeNetworkHint(page, false);
    await page.evaluate(() => (window as any).__tabQA.sockets[0].remoteClose(4404));
    await expect(page.locator('#viewer-stop')).toBeHidden();
    await expect(page.locator('#viewer-status')).toHaveText((await page.locator('[data-phrase="connection.not-found"]').textContent())!.trim());
    await changeNetworkHint(page, true);
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length,
      (window as any).__tabQA.sockets.length, (window as any).__tabQA.sockets[0].readyState])).toEqual([0, 0, 1, 3]);
  });

  test('an introduction failure explains the error and requires another explicit viewer request', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await prepareTabPage(page);
    await page.locator('#viewer-code').fill(code); await page.locator('#viewer-connect').click();
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.sockets[0]?.readyState)).toBe(1);
    await page.evaluate(() => (window as any).__tabQA.sockets[0].emit(new Event('error')));
    await expect(page.locator('#viewer-stop')).toBeHidden();
    await expect(page.locator('#viewer-status')).toHaveText((await page.locator('[data-phrase="connection.server-failed"]').textContent())!.trim());
    await changeNetworkHint(page, false); await changeNetworkHint(page, true);
    expect(await page.evaluate(() => [(window as any).__tabQA.captures.length, (window as any).__tabQA.peers.length,
      (window as any).__tabQA.sockets.length, (window as any).__tabQA.sockets[0].readyState])).toEqual([0, 0, 1, 3]);
    await page.locator('#viewer-connect').click();
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.sockets[1]?.readyState)).toBe(1);
    await page.locator('#viewer-stop').click(); await stoppedTab(page);
  });
});

test.describe('share-tab: native capture across network-state changes', () => {
  test.setTimeout(90_000);
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Native canvas display capture runs in Chromium; refusal and intent checks also run in WebKit.');
    expect(await canFakeCamera(page), 'The independent native canvas capture probe must succeed').toBe(true);
  });

  test('an active host keeps healthy capture until explicit Stop despite network hints', async ({ page, context }) => {
    await networkHint(context); await tabHooks(context); await tabBroker().install(context); await startTabHost(page);
    await changeNetworkHint(page, false); await changeNetworkHint(page, true);
    expect(await page.evaluate(() => ({ calls: (window as any).__tabQA.captures.length,
      tracks: (window as any).__tabQA.tracks.map((track: MediaStreamTrack) => track.readyState) }))).toEqual({ calls: 1, tracks: ['live'] });
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
    await changeNetworkHint(page, false); await changeNetworkHint(page, true);
    expect(await page.evaluate(() => (window as any).__tabQA.captures.length)).toBe(1);
  });

  test('service failure ends capture and starting again needs a fresh picker and invitation', async ({ page, context }) => {
    const broker = tabBroker(); await networkHint(context); await tabHooks(context); await broker.install(context);
    const { invitation } = await startTabHost(page); await broker.failHost(page); await stoppedTab(page, true);
    await changeNetworkHint(page, false); await changeNetworkHint(page, true);
    expect(await page.evaluate(() => ({ calls: (window as any).__tabQA.captures.length,
      tracks: (window as any).__tabQA.tracks.map((track: MediaStreamTrack) => track.readyState),
      sockets: (window as any).__tabQA.sockets.length, peers: (window as any).__tabQA.peers.length })))
      .toEqual({ calls: 1, tracks: ['ended'], sockets: 1, peers: 0 });
    await page.locator('#host-start').click();
    await expect(page.locator('#share-link')).toHaveValue(/#tab-[a-z2-7]{16}$/, { timeout: 20_000 });
    await expect(page.locator('#share-link')).not.toHaveValue(invitation);
    expect(await page.evaluate(() => {
      const state = (window as any).__tabQA;
      return { calls: state.captures.length, tracks: state.tracks.map((track: MediaStreamTrack) => track.readyState),
        freshTrack: state.tracks[0] !== state.tracks[1], sockets: state.sockets.length };
    })).toEqual({ calls: 2, tracks: ['ended', 'live'], freshTrack: true, sockets: 2 });
    await page.locator('#host-stop').click(); await stoppedTab(page, true);
  });
});
