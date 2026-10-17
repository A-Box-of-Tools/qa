import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR, onProductionDomain } from '../lib/site';
import { withoutThirdParties } from '../lib/engine';

const tools = [
  { slug: 'share-text', action: '#publish' },
  { slug: 'share-tab', action: '#viewer-connect' },
  { slug: 'walkie-talkie', action: '#wt-start' },
  { slug: 'voice-oncall', action: '#vi-join' },
  { slug: 'remote-camera', action: '#viewer-connect' },
];
const removed = '#pairing-options, #pairing-auto, #pairing-online, #pairing-offline, '
  + '#offline-host, #offline-viewer-fields, #offline-offer, #offline-offer-input, '
  + '#offline-answer, #offline-answer-input, #offline-reply, #offline-accept, #pairing-qr-dialog';
const site = fs.readFileSync(path.join(ETOOLBOX_DIR, 'config/site.toml'), 'utf8');

for (const tool of tools) for (const query of ['', '?pairing=offline']) test(`${tool.slug}: ${query ? 'a retired manual-mode URL' : 'the normal page'} keeps online pairing and nearby choices`, async ({ page }) => {
  const source = path.join(ETOOLBOX_DIR, 'tools', tool.slug, 'body.html');
  const body = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : '';
  // Only the not-yet-released production tree can lack this contract. A preview
  // which reintroduces controls or loses the normal UI must fail its assertions.
  test.skip(onProductionDomain() && (!body.includes('data-pairing-nearby')
    || /pairing-options|offline-offer-input/.test(body) || !/^pairing_cached\s*=/m.test(site)),
    'The simplified online pairing interface is awaiting the website release.');
  await withoutThirdParties(page);
  // A browser's hint is not evidence about service availability. This supplies
  // an empty discovery directory while refusing any unsolicited room, capture
  // or peer; the existing journeys exercise actual pairing after user actions.
  await page.addInitScript(() => {
    const state = (window as any).__onlinePairing = { online: true, rooms: 0, captures: 0, peers: 0 };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online });
    class Directory extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      constructor(public url: string) {
        super();
        if (new URL(url).pathname !== '/discover') { state.rooms++; throw new Error('An idle page opened a pairing room.'); }
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1; this.emit(new Event('open'));
          const tool = new URL(url).searchParams.get('tool');
          this.emit(new MessageEvent('message', { data: JSON.stringify({ type: 'shares',
            ...(tool && tool !== 'share-text' ? { tool } : {}), list: [] }) }));
        });
      }
      emit(event: Event) { this.dispatchEvent(event); (this as any)[`on${event.type}`]?.(event); }
      send(value: string) { if (value === 'ping') this.emit(new MessageEvent('message', { data: 'pong' })); }
      close() { if (this.readyState === 3) return; this.readyState = 3; this.emit(new CloseEvent('close', { code: 1000 })); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: Directory });
    const NativePeer = window.RTCPeerConnection;
    if (NativePeer) window.RTCPeerConnection = new Proxy(NativePeer, { construct() {
      state.peers++; throw new Error('A network hint started a peer.');
    } });
    const capture = async () => { state.captures++; throw new Error('A network hint started capture.'); };
    const media = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media ? new Proxy(media, { get(target, key) {
      if (key === 'getUserMedia' || key === 'getDisplayMedia') return capture;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) : { getUserMedia: capture, getDisplayMedia: capture } });
  });
  await page.goto(`/${tool.slug}/${query}`);
  await expect(page.locator('[data-pairing-nearby]')).toBeVisible();
  await expect(page.locator(tool.action)).toBeVisible();
  await expect(page.locator(removed)).toHaveCount(0);
  const help = page.locator('[data-pairing-network-help]');
  await expect(help).toBeVisible(); await expect(help).toContainText(/internet/i);
  await expect(page.locator('[data-phrase="offline.ready"]')).toContainText('Internet is still needed to pair or reconnect devices.');
  for (const online of [false, true]) {
    await page.evaluate(online => {
      (window as any).__onlinePairing.online = online;
      window.dispatchEvent(new Event(online ? 'online' : 'offline'));
    }, online);
    await expect(page.locator(removed)).toHaveCount(0);
    await expect(page.locator('[data-pairing-nearby]')).toBeVisible();
    await expect(page.locator(tool.action)).toBeVisible();
    expect(await page.evaluate(() => {
      const { rooms, captures, peers } = (window as any).__onlinePairing;
      return { rooms, captures, peers };
    })).toEqual({ rooms: 0, captures: 0, peers: 0 });
  }
});
