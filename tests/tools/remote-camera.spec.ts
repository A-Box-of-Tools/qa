import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL, ETOOLBOX_DIR } from '../../lib/site';
import fs from 'node:fs';
import path from 'node:path';
import { canFakeCamera, hasCameraInterface, withoutThirdParties } from '../../lib/engine';

const TOOL = '/remote-camera/';
const exists = discoverTools().includes('remote-camera');
type CameraMode = 'allow' | 'deny' | 'pending';

/** Native moving video exercises capture, encoding, decoding and track cleanup.
 * Only the permission prompt and introduction socket are supplied by the suite.
 * The live worker contract is checked separately against an admitted origin. */
async function cameraHooks(page: Page, mode: CameraMode = 'allow', socketMode = 'open') {
  await page.addInitScript(({ mode, socketMode }) => {
    const state = (window as any).__cameraQA = { calls: [] as MediaStreamConstraints[], tracks: [] as MediaStreamTrack[], sockets: [] as any[], release: null as null | (() => void) };
    const makeStream = () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d')!; let frame = 0;
      const paint = () => { ctx.fillStyle = `hsl(${frame++ % 360},70%,45%)`; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#fff'; ctx.fillRect(frame % 500, 150, 100, 100); };
      paint(); const timer = setInterval(paint, 50); const stream = canvas.captureStream(20);
      stream.getTracks().forEach((track) => {
        state.tracks.push(track); const stop = track.stop.bind(track);
        track.stop = () => { stop(); clearInterval(timer); };
      });
      return stream;
    };
    const getUserMedia = async (constraints: MediaStreamConstraints) => {
      state.calls.push(constraints);
      if (mode === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      if (mode === 'pending') await new Promise<void>((resolve) => { state.release = resolve; });
      return makeStream();
    };
    // A WebKit init script can run before the native mediaDevices getter is
    // available. Bind the permission shim to navigator itself so navigation
    // cannot silently leave the real permission prompt in place.
    const media = navigator.mediaDevices;
    const supplied = media ? new Proxy(media, { get(target, property) {
      if (property === 'getUserMedia') return getUserMedia;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) : { getUserMedia };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: supplied });
    if (socketMode === 'broker' || socketMode === 'live') return;
    class QuietSocket extends EventTarget {
      readyState = 0;
      discovery: boolean;
      constructor(public url: string) {
        super(); this.discovery = new URL(url).pathname === '/discover'; state.sockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          const failed = !this.discovery && socketMode === 'fail';
          this.readyState = failed ? 3 : 1;
          this.emit(new Event(failed ? 'error' : 'open'));
          if (this.discovery) this.emit(new MessageEvent('message', { data: JSON.stringify({
            type: 'shares', tool: new URL(this.url).searchParams.get('tool'), list: socketMode === 'listed' ? [{ code: 'qa-listed-camera', local: true }] : [],
          }) }));
        });
      }
      emit(event: Event) { this.dispatchEvent(event); (this as any)[`on${event.type}`]?.(event); }
      send(_data: string) {}
      close() { if (this.readyState === 3) return; this.readyState = 3; this.emit(new CloseEvent('close', { code: 1000 })); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: QuietSocket });
  }, { mode, socketMode });
}
async function sourcePage(page: Page) { await page.goto(TOOL); await page.locator('#role-camera').click(); }
async function tracksStopped(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__cameraQA.tracks.map((track: MediaStreamTrack) => track.readyState))).toEqual(['ended']);
  await expect.poll(() => page.locator('#camera-preview').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
}

/** The broker forwards opaque envelopes; no WebRTC or media object is mocked. */
function localRendezvous() {
  type Client = { page: Page; socket: number; role: string; code: string; peer: string; ready: boolean };
  type Room = { host?: Client; viewers: Map<string, Client>; queue: Promise<void> };
  const rooms = new Map<string, Room>(), clients = new Map<Page, Map<number, Client>>(), watched = new WeakSet<Page>(); let serial = 0;
  const roomFor = (code: string) => { if (!rooms.has(code)) rooms.set(code, { viewers: new Map(), queue: Promise.resolve() }); return rooms.get(code)!; };
  const message = async (client: Client, data: unknown) => {
    if (!client.page.isClosed()) await client.page.evaluate(({ socket, data }) => (window as any).__remoteCameraSockets.get(socket)?.receive(data), { socket: client.socket, data });
  };
  const remoteClose = async (client: Client, code: number) => {
    if (!client.page.isClosed()) await client.page.evaluate(({ socket, code }) => (window as any).__remoteCameraSockets.get(socket)?.remoteClose(code), { socket: client.socket, code });
  };
  const enqueue = (room: Room, work: () => Promise<void>) => { const next = room.queue.then(work); room.queue = next.catch(() => {}); return next; };
  const drop = (client: Client) => {
    clients.get(client.page)?.delete(client.socket);
    const room = roomFor(client.code);
    return enqueue(room, async () => {
      if (client.role === 'host' && room.host === client) {
        room.host = undefined; const viewers = [...room.viewers.values()]; room.viewers.clear();
        for (const viewer of viewers) await remoteClose(viewer, 4410);
      } else if (client.role === 'viewer') {
        room.viewers.delete(client.peer); if (room.host) await message(room.host, { type: 'leave', id: client.peer });
      }
    });
  };
  const install = async (context: BrowserContext) => {
    await context.exposeBinding('__cameraBrokerOpen', ({ page }, socket: number, address: string) => {
      const url = new URL(address), code = url.pathname.split('/').pop()!, role = url.searchParams.get('role')!, room = roomFor(code);
      const client: Client = { page, socket, role, code, peer: `v:${++serial}`, ready: false };
      if (!clients.has(page)) clients.set(page, new Map()); clients.get(page)!.set(socket, client);
      if (role === 'host') room.host = client; else room.viewers.set(client.peer, client);
      if (!watched.has(page)) { watched.add(page); page.on('close', () => { for (const gone of [...(clients.get(page)?.values() ?? [])]) void drop(gone).catch(() => {}); clients.delete(page); }); }
    });
    await context.exposeBinding('__cameraBrokerReady', ({ page }, socket: number) => {
      const client = clients.get(page)?.get(socket); if (!client) return; client.ready = true; const room = roomFor(client.code);
      return enqueue(room, async () => {
        if (!room.host?.ready) return;
        if (client.role === 'viewer') await message(client, { type: 'ready' });
        else for (const viewer of room.viewers.values()) if (viewer.ready) await message(viewer, { type: 'ready' });
      });
    });
    await context.exposeBinding('__cameraBrokerSend', ({ page }, socket: number, raw: string) => {
      const client = clients.get(page)?.get(socket); if (!client) return; const room = roomFor(client.code);
      return enqueue(room, async () => {
        if (raw === 'ping') { await message(client, 'pong'); return; }
        const envelope = JSON.parse(raw);
        if (client.role === 'host') { const viewer = room.viewers.get(envelope.to); if (viewer) await message(viewer, { type: 'signal', data: envelope.data }); }
        else if (room.host) await message(room.host, { type: 'signal', from: client.peer, data: envelope.data });
      });
    });
    await context.exposeBinding('__cameraBrokerClose', ({ page }, socket: number) => { const client = clients.get(page)?.get(socket); if (client) return drop(client); });
    await context.addInitScript(() => {
      const socketMap = (window as any).__remoteCameraSockets = new Map();
      const rtc = (window as any).__remoteCameraRTC = { peers: [] as RTCPeerConnection[], tracks: [] as MediaStreamTrack[] };
      const NativePeer = window.RTCPeerConnection;
      if (NativePeer) window.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args) {
        const peer = Reflect.construct(target, args) as RTCPeerConnection; rtc.peers.push(peer);
        peer.addEventListener('track', (event) => rtc.tracks.push(event.track)); return peer;
      } });
      let serial = 0;
      class BrokerSocket extends EventTarget {
        readyState = 0; id = ++serial; url: string; discovery: boolean;
        constructor(address: string | URL) {
          super(); this.url = String(address); this.discovery = new URL(this.url).pathname === '/discover'; socketMap.set(this.id, this);
          queueMicrotask(async () => {
            // Discovery has its own lifetime and must never join a media room.
            if (this.discovery) {
              if (this.readyState !== 0) return;
              this.readyState = 1; this.emit(new Event('open'));
              this.receive({ type: 'shares', tool: new URL(this.url).searchParams.get('tool'), list: [] }); return;
            }
            await (window as any).__cameraBrokerOpen(this.id, this.url); if (this.readyState !== 0) return;
            this.readyState = 1; this.emit(new Event('open')); await (window as any).__cameraBrokerReady(this.id);
          });
        }
        emit(event: Event) { this.dispatchEvent(event); (this as any)[`on${event.type}`]?.(event); }
        send(data: string) { if (this.readyState !== 1) throw new Error('Socket closed'); if (!this.discovery) void (window as any).__cameraBrokerSend(this.id, data).catch(() => {}); }
        receive(data: unknown) { if (this.readyState === 1) this.emit(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })); }
        remoteClose(code: number) { if (this.readyState === 3) return; this.readyState = 3; this.emit(new CloseEvent('close', { code })); }
        close(code = 1000) { if (this.readyState === 3) return; this.remoteClose(code); if (!this.discovery) void (window as any).__cameraBrokerClose(this.id).catch(() => {}); }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: BrokerSocket });
    });
  };
  return { install };
}

async function requestCamera(viewer: Page, code: string, name: string, invitation?: string) {
  await viewer.goto(`${TOOL}#${code}`); await expect(viewer.locator('#viewer-code')).toHaveValue(code);
  expect(await viewer.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => new URL(socket.url).pathname.startsWith('/ws/') && socket.readyState < 2).length)).toBe(0);
  if (invitation) await viewer.locator('#viewer-code').fill(invitation);
  await viewer.locator('#viewer-name').fill(name); await viewer.locator('#viewer-connect').click();
  await expect.poll(() => viewer.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => new URL(socket.url).pathname.startsWith('/ws/')).map((socket: any) => new URL(socket.url).searchParams.get('tool')))).toEqual(['remote-camera']);
}
async function approveCamera(source: Page, viewer: Page) {
  await expect(source.locator('[data-action=approve]')).toBeVisible({ timeout: 20_000 });
  expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
  expect(await source.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.getSenders().every((sender) => !sender.track)))).toBe(true);
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await source.locator('[data-action=approve]').click();
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(640);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoHeight)).toBe(480);
  const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 10_000 }).toBeGreaterThan(first + 2);
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks().map((track) => track.kind))).toEqual(['video']);
  expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.at(-1).getConfiguration().iceServers)).toEqual([]);
  await expect.poll(() => viewer.evaluate(async () => {
    const report = await (window as any).__remoteCameraRTC.peers.at(-1).getStats();
    const values = [...report.values()] as any[];
    const transport = values.find((item) => item.type === 'transport' && item.selectedCandidatePairId);
    const pair = transport && report.get(transport.selectedCandidatePairId);
    return pair ? [report.get(pair.localCandidateId)?.candidateType, report.get(pair.remoteCandidateId)?.candidateType] : null;
  })).toEqual(['host', 'host']);
}

test.describe('remote-camera: camera lifecycle', () => {
  test.beforeEach(async ({ page }) => { test.skip(!exists, 'Remote Camera is awaiting the website release.'); await withoutThirdParties(page); });
  test('a viewer link waits for consent without capture or room signaling', async ({ page }) => {
    await cameraHooks(page, 'deny'); await page.goto('/remote-camera/#cam-abcdefghijkl');
    await expect(page.locator('#viewer-code')).toHaveValue('cam-abcdefghijkl'); await expect(page.locator('#viewer-code')).toBeVisible();
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
    await page.locator('#viewer-code').fill('invalid code!'); await page.locator('#viewer-connect').click();
    await expect(page.locator('#viewer-status')).toContainText('complete camera code');
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length)).toBe(0);
  });
  test('a listed camera opens the viewing form and waits for Connect', async ({ page }) => {
    await cameraHooks(page, 'deny', 'listed'); await page.goto(TOOL);
    await expect(page.locator('#discovery-list a')).toHaveText('qa-listed-camera');
    await page.locator('#discovery-list a').click();
    await expect(page.locator('#viewer-code')).toHaveValue('qa-listed-camera');
    await expect(page.locator('#viewer-panel')).toBeVisible();
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => socket.discovery && socket.readyState === 1).map((socket: any) => new URL(socket.url).searchParams.get('tool')))).toEqual(['remote-camera']);
  });
  test('an unavailable camera interface explains HTTPS and browser support', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }));
    await sourcePage(page); await page.locator('#camera-start').click();
    await expect(page.locator('#camera-status')).toContainText('trusted HTTPS'); await expect(page.locator('#camera-stop')).toBeHidden();
  });
  test('denied permission leaves no capture or pairing session', async ({ page }) => {
    test.skip(!await hasCameraInterface(page), 'This test engine has no camera interface.');
    await cameraHooks(page, 'deny'); await sourcePage(page); await page.locator('#camera-start').click();
    await expect(page.locator('#camera-status')).toContainText('not allowed'); await expect(page.locator('#camera-start')).toBeEnabled();
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.tracks.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([1, 0, 0]);
  });
  test('Stop cancels pending permission and closes a late grant', async ({ page }) => {
    test.skip(!await canFakeCamera(page), 'This test engine cannot supply a native canvas camera.');
    await cameraHooks(page, 'pending'); await sourcePage(page); await page.locator('#camera-start').click();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__cameraQA.release))).toBe(true);
    await page.locator('#camera-stop').click(); await page.evaluate(() => (window as any).__cameraQA.release());
    await tracksStopped(page); expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length)).toBe(0);
    await expect(page.locator('#camera-start')).toBeEnabled();
  });
  test('Stop releases video and never requests the microphone', async ({ page }) => {
    test.skip(!await canFakeCamera(page), 'This test engine cannot supply a native canvas camera.');
    await cameraHooks(page); await sourcePage(page); await page.locator('#camera-start').click();
    await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
    expect(await page.evaluate(() => (window as any).__cameraQA.calls[0])).toEqual({ video: true, audio: false });
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery && socket.readyState === 1).map((socket: any) => new URL(socket.url).searchParams.get('tool')))).toEqual(['remote-camera']);
    await page.locator('#camera-stop').click(); await tracksStopped(page);
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).every((socket: any) => socket.readyState === 3))).toBe(true);
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => socket.discovery && socket.readyState === 1).length)).toBe(1);
  });
  test('signaling failure releases an already granted camera', async ({ page }) => {
    test.skip(!await canFakeCamera(page), 'This test engine cannot supply a native canvas camera.');
    await cameraHooks(page, 'allow', 'fail'); await sourcePage(page); await page.locator('#camera-start').click();
    await tracksStopped(page); await expect(page.locator('#camera-status')).toContainText('could not stay connected');
    await expect(page.locator('#camera-start')).toBeEnabled();
  });
});

test.describe('remote-camera: native WebRTC media', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(!exists, 'Remote Camera is awaiting the website release.');
    test.skip(browserName !== 'chromium', 'This test build supplies native flowing media reliably in Chromium. Physical Safari remains an acceptance check.');
    test.skip(!await canFakeCamera(page), 'This test engine cannot supply a native canvas camera.'); await withoutThirdParties(page);
  });
  test('approval gates video, denial sends none, and one viewer excludes another', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous();
    const viewerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await sourcePage(page);
      await page.locator('#camera-name').fill('QA Camera Room'); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText('qa-camera-room'); const code = (await page.locator('#camera-code').textContent())!;
      const invitation = await page.locator('#camera-link').inputValue(); expect(new URL(invitation).hash).toBe(`#${code}`);
      await requestCamera(viewer, code, '<img src=x onerror=alert(1)>', invitation); await expect(page.locator('[data-action=deny]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#camera-requests')).toContainText('<img src=x onerror=alert(1)>'); await expect(page.locator('#camera-requests img')).toHaveCount(0);
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
      await page.locator('[data-action=deny]').click(); await expect(viewer.locator('#viewer-status')).toContainText('turned away');
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
      await requestCamera(viewer, code, 'QA approved viewer'); await approveCamera(page, viewer);
      const extra = await viewerContext.newPage(); await withoutThirdParties(extra); await requestCamera(extra, code, 'QA other viewer');
      await expect(extra.locator('#viewer-status')).toContainText('already has a viewer'); expect(await extra.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
      await viewer.locator('#viewer-stop').click(); await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
      await page.locator('#camera-stop').click(); await tracksStopped(page);
    } finally { await viewerContext.close(); }
  });
  test('closing the source clears an approved viewer and closes its peer', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous(), viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await sourcePage(page); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/); const code = (await page.locator('#camera-code').textContent())!;
      await requestCamera(viewer, code, 'QA close'); await approveCamera(page, viewer); await page.close();
      await expect(viewer.locator('#viewer-status')).toContainText('ended', { timeout: 20_000 });
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
    } finally { await viewerContext.close(); }
  });
  test('the live rendezvous carries setup but no viewer note while video advances', async ({ page, context, browser }) => {
    test.setTimeout(60_000);
    const host = new URL(BASE_URL).hostname;
    test.skip(!['localhost', '127.0.0.1', 'abox.tools'].includes(host) && !host.endsWith('.abox-preview.pages.dev'), 'The public rendezvous does not admit this test origin.');
    const source = fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/remote-camera/src/session.js'), 'utf8');
    const rendezvous = source.match(/^const RENDEZVOUS = '(wss:\/\/[^']+)';/m)?.[1];
    expect(rendezvous, 'The live endpoint is read from the tool, not duplicated in QA.').toBeTruthy();
    const endpoint = new URL(rendezvous!).host;
    const frames: string[] = [];
    const watch = (page: Page) => page.on('websocket', (socket) => {
      if (new URL(socket.url()).host !== endpoint) return;
      socket.on('framesent', ({ payload }) => frames.push(String(payload)));
      socket.on('framereceived', ({ payload }) => frames.push(String(payload)));
    });
    const monitor = async (context: BrowserContext) => context.addInitScript(() => {
      const rtc = (window as any).__remoteCameraRTC = { peers: [] as RTCPeerConnection[], tracks: [] as MediaStreamTrack[] };
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(Native, { construct(target, args) {
        const peer = Reflect.construct(target, args) as RTCPeerConnection; rtc.peers.push(peer);
        peer.addEventListener('track', (event) => rtc.tracks.push(event.track)); return peer;
      } });
    });
    const viewerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      await monitor(context); await monitor(viewerContext); await cameraHooks(page, 'allow', 'live'); watch(page);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); watch(viewer);
      await sourcePage(page); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/, { timeout: 20_000 });
      const code = (await page.locator('#camera-code').textContent())!, note = 'QA-camera-note-kept-off-signaling-7f3e';
      await viewer.goto(`${TOOL}#${code}`); await viewer.locator('#viewer-name').fill(note); await viewer.locator('#viewer-connect').click();
      await approveCamera(page, viewer);
      expect(frames.some((frame) => frame.includes('"description"')), 'The captured traffic must contain actual negotiation.').toBe(true);
      expect(frames.length).toBeGreaterThan(4);
      expect(frames.every((frame) => !frame.includes(note)), 'The note must travel the encrypted peer channel.').toBe(true);
      await page.locator('#camera-stop').click(); await tracksStopped(page);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
    } finally { await viewerContext.close(); }
  });
});
