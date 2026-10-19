import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { BASE_URL } from '../lib/site';
import { withoutThirdParties } from '../lib/engine';
import { privateDiscovery, expectTransportMode } from '../lib/pairing-transport';
import { voiceHooks, admitsLiveVoice } from '../lib/voice-fixtures';
import { cameraHooks } from '../lib/camera-fixtures';
import { tabHooks } from '../lib/share-tab';

const tools = ['share-text', 'share-tab', 'remote-camera', 'walkie-talkie', 'voice-oncall'] as const;
type Tool = typeof tools[number];
const groupA = 'A'.repeat(26), groupB = 'B'.repeat(26);
const groupId = (code: string) => createHash('sha256').update('abox.tools/private-discovery/v1\n' + code).digest('hex');
const rows = (page: Page) => page.locator('[data-pairing-nearby] .paired-nearby-row');

// Discovery codes and invitation capabilities must not become failure artifacts.
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.beforeEach(() => test.skip(!privateDiscovery, 'Private discovery groups are awaiting the website release.'));

async function groupDetails(page: Page) {
  const panel = page.locator('[data-discovery-group]');
  await expect(panel).toBeVisible();
  const details = panel.locator('details');
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator('summary').click();
  return panel;
}
async function joinGroup(page: Page, code: string, keyboard = false) {
  const panel = await groupDetails(page);
  await panel.locator('[data-group-code]').fill(code);
  if (keyboard) await panel.locator('[data-group-code]').press('Enter');
  else await panel.locator('[data-group-join]').click();
  await expect(panel).toHaveAttribute('data-group-active', 'private');
  await expect(panel.locator('[data-group-join]')).toBeEnabled();
}
async function beginBrowsing(page: Page, tool: Tool) {
  if (tool === 'share-tab' && await page.locator('#discovery-start').isVisible()) await page.locator('#discovery-start').click();
}
async function noStoredGroup(page: Page, code: string) {
  expect(await page.evaluate(code => {
    const compact = (value: string) => value.replace(/[ -]/g, '').toUpperCase();
    const values = [location.href, ...Object.values(sessionStorage), ...Object.values(localStorage)];
    return values.some(value => compact(String(value)).includes(compact(code)));
  }, code), 'A group code must stay out of page URLs and browser storage.').toBe(false);
}
async function noReportedGroup(page: Page, tool: Tool, code: string) {
  if (tool !== 'share-text' && tool !== 'remote-camera') return;
  if (tool === 'remote-camera') {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('Use the report field.'); } } }));
    const details = page.locator('details:has(#connection-copy)');
    if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
    await page.locator('#connection-copy').click();
  }
  expect(await page.locator('#connection-report').evaluate((input: HTMLTextAreaElement, secret) => {
    const report = JSON.parse(input.value);
    return Array.isArray(report.attempts) && report.attempts.length > 0
      && !input.value.replace(/[ -]/g, '').toUpperCase().includes(secret.toUpperCase());
  }, code)).toBe(true);
}

for (const tool of tools) test(`${tool}: private discovery lists mixed routes with accessible icons and keeps selection separate from joining`, async ({ page, context }) => {
  await withoutThirdParties(page);
  const codes = tool === 'walkie-talkie' || tool === 'voice-oncall' ? ['a'.repeat(64), 'b'.repeat(64)]
    : tool === 'share-tab' ? ['tab-' + 'a'.repeat(16), 'tab-' + 'b'.repeat(16)]
    : ['qa-private-direct', 'qa-private-relay'];
  await context.addInitScript(({ tool, codes, groupA, groupB, idA, idB }) => {
    const state = (window as any).__groupQA = { rooms: 0, captures: 0, peers: 0, sockets: [] as any[], auth: [] as string[] };
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (state.deferGroupHash && new TextDecoder().decode(data).startsWith('abox.tools/private-discovery/v1\n')) {
        state.groupHashWaiting = true;
        return new Promise((resolve, reject) => {
          state.releaseGroupHash = () => { state.groupHashWaiting = false; digest(algorithm, data).then(resolve, reject); };
        });
      }
      return digest(algorithm, data);
    } });
    if (tool === 'voice-oncall' || tool === 'walkie-talkie') {
      // Simulate a previous private host whose in-memory group code was lost on reload.
      sessionStorage.setItem(tool + '.host', JSON.stringify({ code: 'c'.repeat(64), key: 'K'.repeat(43),
        listenKey: 'L'.repeat(43), roomName: 'Former private host', passwordProof: null,
        transport: 'direct', discover: true, discoveryGroup: idA }));
    }
    const entries = codes.map((code, index) => ({ code, local: true, transport: index ? 'relay' : 'direct',
      name: index ? 'QA relay' : 'QA direct', locked: Boolean(index), listenKey: 'L'.repeat(43) }));
    class Directory extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; bufferedAmount = 0; authenticated = false;
      constructor(public url: string) {
        super(); state.sockets.push(this);
        if (new URL(url).pathname !== '/discover') { state.rooms++; return; }
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1; this.emit(new Event('open'));
          if (!new URL(url).searchParams.has('group')) this.list([]);
        });
      }
      emit(event: Event) { this.dispatchEvent(event); (this as any)['on' + event.type]?.(event); }
      list(list: any[], group = new URL(this.url).searchParams.get('group')) {
        this.emit(new MessageEvent('message', { data: JSON.stringify({ type: 'shares',
          ...(tool !== 'share-text' || group ? { tool } : {}), ...(group ? { group } : {}), list }) }));
      }
      send(data: string) {
        if (data === 'ping') { this.emit(new MessageEvent('message', { data: 'pong' })); return; }
        const message = JSON.parse(data);
        if (message.group) {
          const id = new URL(this.url).searchParams.get('group');
          if (message.group === groupA && id === idA) { this.authenticated = true; state.auth.push(idA); this.list(entries); }
          else if (message.group === groupB && id === idB) { this.authenticated = true; state.auth.push(idB); this.list([]); }
          return;
        }
        if (message.refresh && this.authenticated) this.list(new URL(this.url).searchParams.get('group') === idA ? entries : []);
      }
      close() { this.readyState = 3; this.emit(new CloseEvent('close', { code: 1000 })); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: Directory });
    const Peer = window.RTCPeerConnection;
    if (Peer) window.RTCPeerConnection = new Proxy(Peer, { construct() { state.peers++; throw new Error('Discovery started a peer.'); } });
    const capture = async () => { state.captures++; throw new Error('Discovery requested capture.'); };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
      value: { getUserMedia: capture, getDisplayMedia: capture, enumerateDevices: async () => [] } });
  }, { tool, codes, groupA, groupB, idA: groupId(groupA), idB: groupId(groupB) });
  await page.goto('/' + tool + '/');
  await beginBrowsing(page, tool);
  await expect(page.getByRole('heading', { name: 'Available connections', exact: true })).toBeVisible();
  await expect(page.locator('[data-pairing-nearby] [data-transport-toggle]')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  if (tool === 'voice-oncall' || tool === 'walkie-talkie') {
    expect(await page.evaluate(tool => sessionStorage.getItem(tool + '.host') === null, tool)).toBe(true);
  }
  const panel = await groupDetails(page);
  await panel.locator('[data-group-code]').fill('bad');
  await panel.locator('[data-group-code]').press('Enter');
  await expect(panel).toHaveAttribute('data-group-active', 'network');
  expect(await panel.locator('[data-group-code]').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await panel.locator('[data-group-create]').click();
  await expect(panel).toHaveAttribute('data-group-active', 'private');
  const created = await panel.locator('[data-group-code]').inputValue();
  expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(created.replace(/-/g, ''))).toBe(true);
  await noStoredGroup(page, created);
  await panel.locator('[data-group-leave]').click();
  if (tool === 'voice-oncall') await page.locator('#vi-tab-host').click();
  if (tool === 'share-text') { await page.locator('#text').fill('Pending group QA'); await page.locator('#code').fill('qa-pending-group'); }
  if (tool === 'remote-camera') await page.locator('#camera-name').fill('qa-pending-group');
  if (tool === 'walkie-talkie') await page.locator('#wt-room-name').fill('QA pending group');
  if (tool === 'voice-oncall') await page.locator('#vi-room-name').fill('QA pending group');
  const hostStart = page.locator({ 'share-text': '#publish', 'share-tab': '#host-start', 'remote-camera': '#camera-start',
    'walkie-talkie': '#wt-start', 'voice-oncall': '#vi-start' }[tool]);
  await expect(hostStart).toBeEnabled();
  await hostStart.focus();
  await expect(hostStart).toBeFocused();
  await page.evaluate(() => { (window as any).__groupQA.deferGroupHash = true; });
  await panel.locator('[data-group-code]').fill(groupA);
  await panel.locator('[data-group-join]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__groupQA.groupHashWaiting)).toBe(true);
  await hostStart.scrollIntoViewIfNeeded();
  const startBounds = await hostStart.boundingBox();
  expect(startBounds).not.toBeNull();
  // A real click still targets the button's visible position. It must not
  // publish on the old scope while the replacement scope is being derived.
  await page.mouse.click(startBounds!.x + startBounds!.width / 2, startBounds!.y + startBounds!.height / 2);
  await expect(hostStart).not.toBeFocused();
  if (tool === 'voice-oncall') {
    // Enter submits this host form from outside the inert action row.
    await page.locator('#vi-room-name').press('Enter');
    await expect(page.locator('#vi-host-form')).toBeVisible();
  }
  expect(await page.evaluate(() => {
    const qa = (window as any).__groupQA;
    return { rooms: qa.rooms, captures: qa.captures, peers: qa.peers };
  })).toEqual({ rooms: 0, captures: 0, peers: 0 });
  await page.evaluate(() => { const qa = (window as any).__groupQA; qa.deferGroupHash = false; qa.releaseGroupHash(); });
  await expect(panel).toHaveAttribute('data-group-active', 'private');
  await expect(hostStart).toBeEnabled();
  await hostStart.focus();
  await expect(hostStart).toBeFocused();
  await panel.locator('[data-group-leave]').click();
  if (tool === 'voice-oncall') await page.locator('#vi-tab-join').click();
  await joinGroup(page, groupA.toLowerCase().match(/.{1,5}/g)!.join('-'), true);
  await beginBrowsing(page, tool);
  await expect(rows(page)).toHaveCount(2);
  for (const [index, route] of ['direct', 'relay'].entries()) {
    const icon = rows(page).nth(index).locator('[data-connection-kind="' + route + '"]');
    await expect(icon).toHaveRole('img');
    await expect(icon).toHaveAccessibleName(route === 'relay' ? /Cloud relay/ : /Direct/);
    await icon.focus();
    await expect(icon).toBeFocused();
    const tip = icon.locator('.paired-icon-tip');
    await expect(tip).toBeVisible();
    const bounds = await tip.boundingBox();
    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: innerHeight }));
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    await icon.press('Escape');
    await expect(tip).toBeHidden();
  }
  await expect(rows(page).first().locator('[data-connection-kind="open"]')).toBeVisible();
  await expect(rows(page).last().locator('[data-connection-kind="' + (tool === 'voice-oncall' ? 'password' : 'open') + '"]')).toBeVisible();
  if (tool === 'share-tab') await expect(rows(page).last().locator('[data-connection-kind="approval"]')).toBeVisible();
  if (tool === 'share-text' || tool === 'remote-camera') await expect(rows(page).last().locator('[data-connection-kind="optional"]')).toBeVisible();
  await noStoredGroup(page, groupA);
  expect(await page.evaluate(() => {
    const qa = (window as any).__groupQA;
    return { rooms: qa.rooms, captures: qa.captures, peers: qa.peers };
  })).toEqual({ rooms: 0, captures: 0, peers: 0 });

  // The new directory clears old rows and ignores a stale response from the old socket.
  await joinGroup(page, groupB);
  await beginBrowsing(page, tool);
  await expect(rows(page)).toHaveCount(0);
  await page.evaluate(() => {
    const old = (window as any).__groupQA.sockets.find((socket: any) => socket.readyState === 3 && new URL(socket.url).searchParams.has('group'));
    old?.list([{ code: 'stale-private-entry', local: true }]);
  });
  await expect(rows(page)).toHaveCount(0);
  await page.locator('[data-group-leave]').click();
  await expect(page.locator('[data-discovery-group]')).toHaveAttribute('data-group-active', 'network');
  await expect(rows(page)).toHaveCount(0);
  await joinGroup(page, groupA);
  await beginBrowsing(page, tool);
  await expect(rows(page)).toHaveCount(2);
  if (tool === 'share-text') {
    const href = await rows(page).last().locator('a').getAttribute('href');
    expect(Boolean(href && !href.includes(groupA) && !href.includes(groupId(groupA)))).toBe(true);
    await page.goto(href!);
  } else if (tool === 'voice-oncall') await rows(page).last().locator('input').check();
  else await rows(page).last().locator('button').click();
  await expectTransportMode(page, 'relay');
  const consent = tool === 'walkie-talkie' ? page.locator('#wt-join')
    : page.locator({ 'share-text': '#connect', 'share-tab': '#viewer-connect', 'remote-camera': '#viewer-connect', 'voice-oncall': '#vi-join' }[tool]);
  await expect(consent).toBeVisible();
  await expect(consent).toBeEnabled();
  expect(await page.evaluate(() => {
    const qa = (window as any).__groupQA;
    return { rooms: qa.rooms, captures: qa.captures, peers: qa.peers };
  })).toEqual({ rooms: 0, captures: 0, peers: 0 });
  await noStoredGroup(page, groupA);
});

for (const tool of tools) test(`${tool}: a live private host is isolated from local and wrong groups and Stop withdraws it`, async ({ page, browser, browserName }, info) => {
  test.skip(browserName !== 'chromium' || info.project.name !== 'Desktop Chrome', 'Live directory lifecycle runs once on desktop Chromium.');
  test.skip(!admitsLiveVoice(), 'The live rendezvous does not admit this test origin.');
  test.setTimeout(180_000);
  await withoutThirdParties(page);
  if (tool === 'share-tab') await tabHooks(page.context(), { live: true });
  if (tool === 'remote-camera') await cameraHooks(page, 'allow', 'live');
  if (tool === 'walkie-talkie') await voiceHooks(page, 'allow');
  if (tool === 'voice-oncall') await voiceHooks(page, 'deny');
  const viewerContext = await browser.newContext({ baseURL: BASE_URL });
  const viewer = await viewerContext.newPage();
  await withoutThirdParties(viewer);
  await viewer.addInitScript(() => {
    const ready: (string | null)[] = [];
    (window as any).__directoryReady = ready;
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
      const socket = Reflect.construct(target, args) as WebSocket;
      if (new URL(String(args[0])).pathname === '/discover') socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === 'shares') ready.push(message.group ?? null);
        } catch { /* Only record directory acknowledgements, not credentials or entries. */ }
      });
      return socket;
    } });
  });
  const groupCode = 'Q'.repeat(10) + Date.now().toString(32).toUpperCase().replace(/[ILOU]/g, 'X').padStart(16, '0');
  try {
    await page.goto('/' + tool + '/');
    await joinGroup(page, groupCode);
    if (tool === 'voice-oncall') await page.locator('#vi-tab-host').click();
    await expectTransportMode(page, 'direct');
    const id = 'qa-private-' + Date.now().toString(36);
    if (tool === 'share-text') {
      await page.locator('#text').fill('Private directory QA content');
      await page.locator('#code').fill(id);
      await page.locator('#discoverable').check();
    }
    if (tool === 'share-tab') await page.locator('#host-discoverable').check();
    if (tool === 'remote-camera') { await page.locator('#camera-name').fill(id); await page.locator('#camera-discoverable').check(); }
    if (tool === 'walkie-talkie') { await page.locator('#wt-room-name').fill(id); await page.locator('#wt-discover').check(); }
    if (tool === 'voice-oncall') {
      await page.locator('#vi-room-name').fill(id); await page.locator('#vi-password-required').check();
      await page.locator('#vi-host-password').fill('QA private pager password');
    }
    const start = { 'share-text': '#publish', 'share-tab': '#host-start', 'remote-camera': '#camera-start', 'walkie-talkie': '#wt-start', 'voice-oncall': '#vi-start' }[tool];
    const link = { 'share-text': '#link', 'share-tab': '#share-link', 'remote-camera': '#camera-link', 'walkie-talkie': '#wt-link', 'voice-oncall': '#vi-link' }[tool];
    await page.locator(start).click();
    await expect.poll(async () => Boolean(await page.locator(link).inputValue()), { timeout: 30_000 }).toBe(true);
    const invitation = await page.locator(link).inputValue();
    expect(!invitation.includes(groupCode) && !invitation.includes(groupId(groupCode))).toBe(true);
    await expect(page.locator('[data-group-code]')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('[data-group-copy]')).toBeVisible();
    await expect(page.locator('[data-group-copy]')).toBeEnabled();
    await expect(page.locator('[data-group-join]')).toBeDisabled();
    await expect(page.locator('[data-group-create]')).toBeDisabled();
    await expect(page.locator('[data-group-leave]')).toBeDisabled();
    await noStoredGroup(page, groupCode);
    await noReportedGroup(page, tool, groupCode);

    await viewer.goto('/' + tool + '/');
    await beginBrowsing(viewer, tool);
    const match = tool === 'walkie-talkie' || tool === 'voice-oncall' ? id : new URL(invitation).hash.slice(1);
    await expect.poll(() => viewer.evaluate(() => (window as any).__directoryReady.includes(null)), { timeout: 75_000 }).toBe(true);
    await expect(rows(viewer).filter({ hasText: match })).toHaveCount(0);
    await joinGroup(viewer, groupB);
    await beginBrowsing(viewer, tool);
    await expect.poll(() => viewer.evaluate(id => (window as any).__directoryReady.includes(id), groupId(groupB)), { timeout: 75_000 }).toBe(true);
    await expect(rows(viewer).filter({ hasText: match })).toHaveCount(0);
    await joinGroup(viewer, groupCode);
    await beginBrowsing(viewer, tool);
    const listing = rows(viewer).filter({ hasText: match });
    await expect(listing).toHaveCount(1, { timeout: 75_000 });
    await expect(listing.locator('[data-connection-kind="direct"]')).toBeVisible();
    await expect(listing.locator('[data-connection-kind="' + (tool === 'voice-oncall' ? 'password' : 'open') + '"]')).toBeVisible();
    const stop = { 'share-text': '#stop', 'share-tab': '#host-stop', 'remote-camera': '#camera-stop', 'walkie-talkie': '#wt-end', 'voice-oncall': '#vi-end' }[tool];
    await page.locator(stop).click();
    await expect(listing).toHaveCount(0, { timeout: 25_000 });
    await expect(page.locator('[data-group-code]')).toBeEditable();
    await expect(page.locator('[data-group-leave]')).toBeEnabled();
    await noStoredGroup(page, groupCode);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(listing).toHaveCount(0);
  } finally { await viewerContext.close(); }
});
