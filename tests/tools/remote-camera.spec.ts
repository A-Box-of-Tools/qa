import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import { BASE_URL, ETOOLBOX_DIR } from '../../lib/site';
import { liveRendezvous } from '../../lib/rendezvous';
import { unifiedPairingJoin } from '../../lib/pairing-approval';
import fs from 'node:fs';
import path from 'node:path';
import { cameraHooks } from '../../lib/camera-fixtures';
import { observePairing, attachPairingDiagnostics } from '../../lib/pairing-diagnostics';
import { canFakeCamera, hasCameraInterface, withoutThirdParties } from '../../lib/engine';

const TOOL = '/remote-camera/';
const exists = discoverTools().includes('remote-camera');
// Production and a dev preview can use different discovery contracts while
// a release awaits approval. The checked-out website source identifies each.
const cameraSource = exists ? fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/remote-camera/src/main.js'), 'utf8') : '';
const captureRecovery = cameraSource.includes('async function resumeCamera(');
const cameraBody = exists ? fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/remote-camera/body.html'), 'utf8') : '';
const selectNearby = cameraBody.includes('data-pairing-nearby');
const directDiscovery = !selectNearby && cameraSource.includes("link.addEventListener('click'");
const approvalPopup = cameraBody.includes('id="camera-request-dialog"');
const connectionReports = cameraBody.includes('id="connection-report"');

/** Native scoped workers stay active; permission and OS delivery are supplied. */
async function notificationHooks(page: Page, reply: 'granted' | 'denied' | 'pending') {
  await page.addInitScript((reply) => {
    const state = (window as any).__cameraNotifications = { requests: 0, shown: [] as any[], release: null as null | ((permission: NotificationPermission) => void) };
    class PermissionNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission() {
        state.requests++;
        const permission = reply === 'pending'
          ? await new Promise<NotificationPermission>((resolve) => { state.release = resolve; }) : reply;
        PermissionNotification.permission = permission;
        return permission;
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: PermissionNotification });
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'showNotification', { configurable: true, value: async function (this: ServiceWorkerRegistration, title: string, options: NotificationOptions = {}) {
      state.shown.push({ title, options, scope: this.scope, closed: false });
    } });
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'getNotifications', { configurable: true, value: async function (options?: { tag?: string }) {
      return state.shown.filter((entry: any) => !entry.closed && (!options?.tag || entry.options.tag === options.tag))
        .map((entry: any) => ({ tag: entry.options.tag, close() { entry.closed = true; } }));
    } });
  }, reply);
}
async function sourcePage(page: Page) { await page.goto(TOOL); await expect(page.locator('#camera-panel')).toBeVisible(); }
async function tracksStopped(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const tracks: MediaStreamTrack[] = (window as any).__cameraQA.tracks;
    return tracks.length > 0 && tracks.every((track) => track.readyState === 'ended');
  })).toBe(true);
  await expect.poll(() => page.locator('#camera-preview').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
}

/** Notification simulation only; native capture, video and peers keep running. */
async function simulateCameraVisibility(page: Page) {
  await page.evaluate(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
    (window as any).__setCameraHidden = (value: boolean) => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
  });
}

/** Keep existing list and Stop journeys usable without bypassing a native modal. */
async function reviewCameraRequestLater(source: Page) {
  const dialog = source.locator('#camera-request-dialog');
  if (!await dialog.isVisible()) return;
  await source.locator('#camera-request-later').click();
  await expect(dialog).toBeHidden();
}

async function cameraClipboard(page: Page | BrowserContext) {
  await page.addInitScript(() => {
    const state = (window as any).__cameraClipboard = { denied: false, writes: [] as string[] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => {
        state.writes.push(text);
        if (state.denied) throw new DOMException('Clipboard denied', 'NotAllowedError');
      },
    } });
  });
}

async function openCameraDetails(page: Page) {
  const details = page.locator('#connection-details');
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) await details.locator('summary').click();
}

async function copyCameraReport(page: Page) {
  await openCameraDetails(page);
  const writes = await page.evaluate(() => (window as any).__cameraClipboard.writes.length);
  await page.locator('#connection-copy').click();
  await expect.poll(() => page.evaluate(() => (window as any).__cameraClipboard.writes.length)).toBe(writes + 1);
  return page.evaluate(() => (window as any).__cameraClipboard.writes.at(-1) as string);
}

/** The product retains sanitized operation failures after its native peer closes.
 * Export through its existing handler without waiting for a modal or animation:
 * this is failure evidence, not a claim about the Copy button's usability. */
async function attachCameraFailureReports(camera: Page, contexts: BrowserContext[]) {
  if (!connectionReports) return;
  const pages = { camera, ...Object.fromEntries(contexts.flatMap(context => context.pages())
    .slice(0, 16).map((page, index) => [`viewer${index + 1}`, page])) };
  const collect = async () => {
    const reports: Record<string, unknown> = {};
    for (const [role, page] of Object.entries(pages)) {
      try {
        if (page.isClosed()) { reports[role] = { closed: true }; continue; }
        const text = await page.evaluate(() => {
          const clipboard = (window as any).__cameraClipboard;
          const button = document.querySelector<HTMLButtonElement>('#connection-copy');
          if (!clipboard || !button) return null;
          const before = clipboard.writes.length;
          button.click();
          return clipboard.writes.length > before ? clipboard.writes.at(-1) as string : null;
        });
        if (!text || text.length > 512_000) { reports[role] = { unavailable: true }; continue; }
        const report = JSON.parse(text);
        reports[role] = report.schema === 1 && report.tool === 'remote-camera'
          && Array.isArray(report.attempts) && report.attempts.length <= 12 ? report : { unavailable: true };
      } catch { reports[role] = { unavailable: true }; }
    }
    return reports;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reports = await Promise.race([collect(), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000); })]);
  clearTimeout(timer);
  if (!reports) return;
  await test.info().attach('camera-product-connection-reports', {
    body: JSON.stringify({ schema: 1, browserProject: test.info().project.name, reports }, null, 2),
    contentType: 'application/json',
  });
}

async function downloadCameraReport(page: Page) {
  await openCameraDetails(page);
  const downloaded = page.waitForEvent('download');
  await page.locator('#connection-download').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('remote-camera-connection-report.json');
  const saved = await download.path(); expect(saved).toBeTruthy();
  await expect(page.locator('#connection-report-status')).toContainText('download started');
  return fs.readFileSync(saved!, 'utf8');
}

/** The dialog is absent on production until the confirmation release lands. */
async function cancelCameraStop(source: Page, viewer: Page, pending = false) {
  await reviewCameraRequestLater(source);
  const dialog = source.locator('#camera-stop-dialog');
  if (await dialog.count() === 0) return;
  const invitation = await source.locator('#camera-link').inputValue();
  for (const dismiss of ['button', 'Escape']) {
    await source.locator('#camera-stop').click();
    await expect(dialog).toBeVisible();
    await expect(source.locator('#camera-stop-cancel')).toBeFocused();
    if (dismiss === 'button') await source.locator('#camera-stop-cancel').click();
    else await source.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(source.locator('#camera-stop')).toBeFocused();
    await expect(source.locator('#camera-link')).toHaveValue(invitation);
    expect(await source.locator('#camera-preview').evaluate((video: HTMLVideoElement) => {
      const tracks = (video.srcObject as MediaStream | null)?.getVideoTracks() ?? [];
      return tracks.length > 0 && tracks.every((track) => track.readyState === 'live');
    })).toBe(true);
    if (pending) {
      await expect(source.locator('[data-action=deny]')).toBeVisible();
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
    } else {
      const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(first + 2);
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.at(-1).connectionState)).toBe('connected');
    }
  }
}

async function stopSharedCamera(source: Page) {
  await reviewCameraRequestLater(source);
  await source.locator('#camera-stop').click();
  const dialog = source.locator('#camera-stop-dialog');
  if (await dialog.count() === 0) return;
  await expect(dialog).toBeVisible();
  await expect(source.locator('#camera-stop-cancel')).toBeFocused();
  await source.locator('#camera-stop-confirm').click();
  await expect(dialog).toBeHidden();
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
  const previousRooms = await viewer.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => new URL(socket.url).pathname.startsWith('/ws/')).length);
  if (invitation) await viewer.locator('#viewer-code').fill(invitation);
  await viewer.locator('#viewer-name').fill(name); await viewer.locator('#viewer-connect').click();
  // Returning to the same fragment can preserve the closed, denied attempt.
  await expect.poll(() => viewer.evaluate((previousRooms) => [...(window as any).__remoteCameraSockets.values()]
    .filter((socket: any) => new URL(socket.url).pathname.startsWith('/ws/')).slice(previousRooms)
    .map((socket: any) => { const url = new URL(socket.url); return { tool: url.searchParams.get('tool'), role: url.searchParams.get('role'), code: url.pathname.split('/').pop() }; }), previousRooms))
    .toEqual([{ tool: 'remote-camera', role: 'viewer', code }]);
}

async function requestListedCamera(viewer: Page, code: string, name: string) {
  if (!directDiscovery && !selectNearby) return requestCamera(viewer, code, name);
  await viewer.goto(TOOL); await viewer.locator('#viewer-name').fill(name);
  await expect.poll(() => viewer.evaluate(() => [...(window as any).__remoteCameraSockets.values()].some((socket: any) => socket.discovery && socket.readyState === 1))).toBe(true);
  await viewer.evaluate((code) => {
    const discovery = [...(window as any).__remoteCameraSockets.values()].find((socket: any) => socket.discovery && socket.readyState === 1) as any;
    discovery.receive({ type: 'shares', tool: 'remote-camera', list: [{ code, local: true }] });
  }, code);
  const camera = viewer.locator(selectNearby ? '#discovery-list button' : '#discovery-list a');
  if (unifiedPairingJoin) {
    await expect(camera).toHaveText('Join');
    await expect(camera).toHaveAccessibleName(new RegExp(code));
  } else await expect(camera).toContainText(code);
  await camera.focus(); await camera.press('Enter');
  await expect(viewer.locator('#viewer-code')).toHaveValue(code);
  if (selectNearby && !unifiedPairingJoin) {
    await expect(viewer.locator('#viewer-connect')).toBeFocused();
    expect(await viewer.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => !socket.discovery).length)).toBe(0);
    expect(await viewer.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(0);
    await viewer.locator('#viewer-connect').click();
  }
  await expect(viewer.locator('#viewer-stop')).toBeFocused();
  expect(await viewer.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(0);
  await expect.poll(() => viewer.evaluate(() => [...(window as any).__remoteCameraSockets.values()]
    .filter((socket: any) => !socket.discovery).map((socket: any) => {
      const url = new URL(socket.url); return { tool: url.searchParams.get('tool'), role: url.searchParams.get('role'), code: url.pathname.split('/').pop() };
    }))).toEqual([{ tool: 'remote-camera', role: 'viewer', code }]);
}
async function approveCamera(source: Page, viewer: Page) {
  await expect(source.locator('[data-action=approve]')).toBeVisible({ timeout: 20_000 });
  await reviewCameraRequestLater(source);
  expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
  expect(await source.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.getSenders().every((sender) => !sender.track)))).toBe(true);
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  await source.locator('[data-action=approve]').click();
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(640);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoHeight)).toBe(480);
  const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 10_000 }).toBeGreaterThan(first + 2);
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks().map((track) => track.kind))).toEqual(['video']);
  if (await viewer.locator('#viewer-listen').count()) await expect(viewer.locator('#viewer-listen')).toBeHidden();
  if (await viewer.locator('#viewer-sound-alert').count()) await expect(viewer.locator('#viewer-sound-alert')).toBeDisabled();
  expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.at(-1).getConfiguration().iceServers)).toEqual([]);
  await expect.poll(() => viewer.evaluate(async () => {
    const report = await (window as any).__remoteCameraRTC.peers.at(-1).getStats();
    const values = [...report.values()] as any[];
    const transport = values.find((item) => item.type === 'transport' && item.selectedCandidatePairId);
    const pair = transport && report.get(transport.selectedCandidatePairId);
    return pair ? [report.get(pair.localCandidateId)?.candidateType, report.get(pair.remoteCandidateId)?.candidateType] : null;
  })).toEqual(['host', 'host']);
}

/** Hold only the consent acknowledgement; the channel and RTP stay native. */
async function holdCameraApprovalAck(page: Page) {
  await page.addInitScript(() => {
    const state = (window as any).__cameraAck = { held: false, release: null as null | (() => void) };
    const send = RTCDataChannel.prototype.send;
    Object.defineProperty(RTCDataChannel.prototype, 'send', { configurable: true, value: function (this: RTCDataChannel, data: any) {
      if (typeof data === 'string' && JSON.parse(data).type === 'approval-ack' && !state.release) {
        state.held = true; state.release = () => { state.held = false; (send as any).call(this, data); }; return;
      }
      return (send as any).call(this, data);
    } });
  });
}

async function pendingCameraRequest(source: Page, viewer: Page, name: string) {
  const row = source.locator('#camera-requests .camera-request').filter({ hasText: name });
  const approve = row.locator('[data-action=approve]');
  await expect(approve).toBeVisible({ timeout: 20_000 });
  await reviewCameraRequestLater(source);
  const id = await approve.getAttribute('data-peer'); expect(id).toBeTruthy();
  expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  const peer = await source.evaluate(() => (window as any).__remoteCameraRTC.peers.length - 1);
  expect(await source.evaluate((peer) => (window as any).__remoteCameraRTC.peers[peer].getSenders().every((sender: RTCRtpSender) => !sender.track), peer)).toBe(true);
  return { id: id!, peer, approve };
}

async function flowingCamera(viewer: Page, audio = false, width: number | null = 640) {
  const dimensions = expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 });
  if (width === null) await dimensions.toBeGreaterThan(0); else await dimensions.toBe(width);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks().map((track) => track.kind).sort()))
    .toEqual(audio ? ['audio', 'video'] : ['video']);
  const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 10_000 }).toBeGreaterThan(first + 2);
  expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.at(-1).connectionState)).toBe('connected');
}

async function videoSenderCaps(source: Page) {
  return source.evaluate(() => (window as any).__remoteCameraRTC.peers
    .filter((peer: RTCPeerConnection) => peer.connectionState === 'connected')
    .flatMap((peer: RTCPeerConnection) => peer.getSenders())
    .filter((sender: RTCRtpSender) => sender.track?.kind === 'video' && sender.track.readyState === 'live')
    .map((sender: RTCRtpSender) => sender.getParameters().encodings[0]?.maxBitrate ?? 0) as number[]);
}

async function boundedVideoSenders(source: Page, viewers: number, budget: number) {
  await expect.poll(async () => {
    const caps = await videoSenderCaps(source);
    return caps.length === viewers && caps.every((cap) => cap > 0 && cap === caps[0]) && caps.reduce((sum, cap) => sum + cap, 0) <= budget;
  }, { timeout: 20_000 }).toBe(true);
  return videoSenderCaps(source);
}

async function viewerHelp(page: Page, id: string, touch = false) {
  const help = page.locator(`#${id}`), summary = help.locator('summary');
  const description = await summary.getAttribute('aria-describedby');
  expect(description).toBeTruthy();
  const note = page.locator(`#${description}`);
  await expect(note).toHaveAttribute('role', 'tooltip');
  await expect(note).toBeHidden();
  await summary.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await expect(summary).toBeFocused(); await expect(note).toBeVisible();
  await page.keyboard.press('Escape'); await expect(note).toBeHidden();
  if (touch) {
    await summary.tap(); await expect(note).toBeVisible();
    await page.locator('#viewer-panel h2').tap(); await expect(note).toBeHidden();
  } else {
    await summary.hover(); await expect(note).toBeVisible();
    await page.locator('#viewer-panel h2').click(); await expect(note).toBeHidden();
  }
}

async function viewerOverlay(page: Page, audio = false) {
  const frame = page.locator('#viewer-video-frame');
  if (await frame.count() === 0) return;
  for (const id of ['viewer-fullscreen', ...(audio ? ['viewer-listen'] : [])]) {
    const button = frame.locator(`#${id}`); await expect(button).toBeVisible();
    expect(await button.evaluate((control) => {
      const video = document.querySelector('#remote-video')!.getBoundingClientRect(), bounds = control.getBoundingClientRect();
      return bounds.left >= video.left && bounds.top >= video.top && bounds.right <= video.right && bounds.bottom <= video.bottom;
    }), `${id} stays on the video, including at narrow widths.`).toBe(true);
  }
  await frame.locator('#viewer-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('viewer-video-frame');
  await expect(frame.locator('#viewer-fullscreen')).toBeVisible();
  if (audio) await expect(frame.locator('#viewer-listen')).toBeVisible();
  await frame.locator('#viewer-fullscreen').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
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
  test('a listed camera follows the shipped viewing request contract without capture', async ({ page }) => {
    await cameraHooks(page, 'deny', 'listed'); await page.goto(TOOL);
    const choice = page.locator(selectNearby ? '#discovery-list button' : '#discovery-list a');
    if (unifiedPairingJoin) {
      await expect(choice).toHaveText('Join');
      expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length,
        (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
      await choice.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect(page.locator('#viewer-code')).toHaveValue('qa-listed-camera');
      await expect(page.locator('#viewer-stop')).toBeVisible();
      await expect(page.locator('#camera-discovery')).toBeHidden();
      expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length,
        (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 1]);
      return;
    }
    await expect(choice).toContainText('qa-listed-camera');
    if (directDiscovery) await choice.evaluate((link: HTMLElement) => { link.click(); link.click(); (document.querySelector('#viewer-connect') as HTMLButtonElement).click(); });
    else await choice.click();
    await expect(page.locator('#viewer-code')).toHaveValue('qa-listed-camera');
    await expect(page.locator('#viewer-panel')).toBeVisible();
    if (directDiscovery) {
      await expect(page.locator('#camera-panel')).toBeHidden(); await expect(page.locator('#camera-discovery')).toBeHidden();
      await expect(page.locator('#viewer-stop')).toBeFocused(); await expect(page.locator('#viewer-connect')).toBeDisabled();
    } else {
      await expect(page.locator('#camera-discovery')).toBeVisible();
      await expect(page.locator(selectNearby ? '#viewer-connect' : '#viewer-code')).toBeFocused();
      await expect(page.locator('#viewer-connect')).toBeEnabled(); await expect(page.locator('#viewer-stop')).toBeHidden();
    }
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, directDiscovery ? 1 : 0]);
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => socket.discovery && socket.readyState === 1).map((socket: any) => new URL(socket.url).searchParams.get('tool')))).toEqual(['remote-camera']);
    if (selectNearby) {
      // Repeated selection cannot start the request; one deliberate Connect
      // still opens exactly one room even if the click is delivered twice.
      await choice.click();
      expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length)).toBe(0);
      await page.locator('#viewer-connect').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length,
        (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 1]);
      await expect(page.locator('#camera-discovery')).toBeHidden();
    }
  });
  test('a listed-camera choice preserves deliberate navigation and pairing', async ({ page }) => {
    await cameraHooks(page, 'deny', 'listed'); await page.goto(TOOL);
    if (selectNearby) {
      const choice = page.locator('#discovery-list button');
      const before = page.url();
      await page.evaluate(() => { (window as any).__cameraJoinDocument = true; });
      if (unifiedPairingJoin) await expect(choice).toHaveText('Join');
      else await expect(choice).toContainText('qa-listed-camera');
      await choice.focus(); await choice.press('Enter');
      await expect(page.locator('#viewer-code')).toHaveValue('qa-listed-camera');
      await expect(page.locator(unifiedPairingJoin ? '#viewer-stop' : '#viewer-connect')).toBeFocused();
      if (unifiedPairingJoin) {
        const selected = new URL(before);
        selected.hash = 'qa-listed-camera';
        expect(page.url()).toBe(selected.href);
        expect(await page.evaluate(() => (window as any).__cameraJoinDocument === true)).toBe(true);
      } else expect(page.url()).toBe(before);
      expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length,
        (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, unifiedPairingJoin ? 1 : 0]);
      return;
    }
    const camera = page.locator('#discovery-list a'); await expect(camera).toHaveText('qa-listed-camera');
    expect(await camera.getAttribute('href')).toContain('#qa-listed-camera');
    const intercepted = await camera.evaluate((link) => {
      let intercepted = false;
      link.addEventListener('click', (event) => { intercepted = event.defaultPrevented; event.preventDefault(); }, { once: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
      return intercepted;
    });
    expect(intercepted).toBe(false);
    await expect(page.locator('#viewer-connect')).toBeEnabled(); await expect(page.locator('#viewer-stop')).toBeHidden();
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
    await expect(page.locator('#camera-discovery')).toBeVisible();
  });
  test('pairing tools display the shipped JavaScript version', async ({ page }) => {
    await cameraHooks(page, 'deny'); await page.goto(TOOL);
    const version = page.locator('[data-pairing-version]'); await expect(version).toBeVisible();
    const fingerprint = await version.getAttribute('data-pairing-version'); expect(fingerprint).toMatch(/^[a-f0-9]{10}$/);
    expect(await page.locator('script[src^="src/main.js?"]').getAttribute('src')).toContain(`v=${fingerprint}`);
    await expect(page.locator('#camera-require-approval')).toBeChecked();
    await page.goto('/share-text/'); await expect(page.locator('[data-pairing-version]')).toBeVisible();
    const textVersion = await page.locator('[data-pairing-version]').getAttribute('data-pairing-version');
    expect(await page.locator('script[src^="src/main.js?"]').getAttribute('src')).toContain(`v=${textVersion}`);
  });
  test('an unavailable camera interface explains HTTPS and browser support', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }));
    await sourcePage(page); await page.locator('#camera-start').click();
    await expect(page.locator('#camera-status')).toContainText('trusted HTTPS'); await expect(page.locator('#camera-stop')).toBeHidden();
  });
  test('connection reports copy, remain selectable after clipboard refusal, and download without capture', async ({ page }) => {
    test.skip(!connectionReports, 'Camera connection reports are awaiting the website release.');
    await cameraClipboard(page); await cameraHooks(page, 'deny'); await sourcePage(page);
    const text = await copyCameraReport(page), report = JSON.parse(text);
    await expect(page.locator('#connection-report-status')).toContainText('copied');
    await expect(page.locator('#connection-report-field')).toBeHidden();
    expect(report).toMatchObject({ schema: 1, tool: 'remote-camera', attemptsDropped: 0, attempts: [] });
    expect(report.toolVersion).toBe(await page.locator('[data-pairing-version]').getAttribute('data-pairing-version'));
    expect(report.browser.family).not.toBe('unknown');
    expect(report.browser.version).toMatch(/^\d+(?:\.\d+)*$/);

    await page.evaluate(() => { (window as any).__cameraClipboard.denied = true; });
    expect(await copyCameraReport(page)).toBe(text);
    const selected = page.locator('#connection-report');
    await expect(selected).toBeVisible(); await expect(selected).toHaveValue(text);
    await expect(selected).toHaveAttribute('readonly', ''); await expect(selected).toBeFocused();
    expect(await selected.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([0, text.length]);
    await expect(page.locator('#connection-report-status')).toContainText('Select and copy');
    expect(JSON.parse(await downloadCameraReport(page))).toEqual(report);
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length,
      (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
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
    await cameraHooks(page); await sourcePage(page);
    const audio = page.locator('#camera-audio');
    if (await audio.count()) await expect(audio).not.toBeChecked();
    await page.locator('#camera-start').click();
    await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
    if (await audio.count()) await expect(audio).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__cameraQA.calls[0])).toEqual({ video: true, audio: false });
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery && socket.readyState === 1).map((socket: any) => new URL(socket.url).searchParams.get('tool')))).toEqual(['remote-camera']);
    await page.locator('#camera-stop').click(); await tracksStopped(page);
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).every((socket: any) => socket.readyState === 3))).toBe(true);
    expect(await page.evaluate(() => (window as any).__cameraQA.sockets.filter((socket: any) => socket.discovery && socket.readyState === 1).length)).toBe(1);
  });
  test('unsupported browser alerts stay hidden and audio choices start off', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'Notification', { configurable: true, value: undefined });
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    });
    await cameraHooks(page, 'deny'); await sourcePage(page);
    test.skip(await page.locator('#camera-audio').count() === 0, 'Camera audio and alerts are awaiting the website release.');
    await expect(page.locator('#camera-audio')).not.toBeChecked();
    await expect(page.locator('#viewer-motion-alert')).not.toBeChecked();
    await expect(page.locator('#viewer-sound-alert')).not.toBeChecked();
    await expect(page.locator('#viewer-alert-options')).toBeHidden();
    await expect(page.locator('#viewer-sound-option')).toBeHidden();
    await expect(page.locator('#viewer-listen')).toBeHidden();
  });
  test('viewer descriptions open with keyboard and touch and dismiss without pairing', async ({ page, browser }) => {
    await cameraHooks(page, 'deny'); await sourcePage(page);
    test.skip(await page.locator('#viewer-video-frame').count() === 0, 'Viewer overlay and help are awaiting the website release.');
    for (const id of ['viewer-name-help', 'viewer-connection-help']) await viewerHelp(page, id);
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
    const touchContext = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      const touch = await touchContext.newPage(); await withoutThirdParties(touch); await cameraHooks(touch, 'deny'); await sourcePage(touch);
      for (const id of ['viewer-name-help', 'viewer-connection-help']) await viewerHelp(touch, id, true);
      expect(await touch.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__cameraQA.sockets.filter((socket: any) => !socket.discovery).length])).toEqual([0, 0]);
    } finally { await touchContext.close(); }
  });
  test('initial signaling failure releases capture and offers Resume with the same viewer link', async ({ page }) => {
    test.skip(!captureRecovery, 'Camera capture recovery is awaiting the website release.');
    test.skip(!await canFakeCamera(page), 'This test engine cannot supply a native canvas camera.');
    await cameraHooks(page, 'allow', 'fail'); await sourcePage(page);
    const code = await page.locator('#camera-name').inputValue(); await page.locator('#camera-start').click();
    await tracksStopped(page); await expect(page.locator('#camera-status')).toContainText('Choose Resume camera to try the same viewer link');
    await expect(page.locator('#camera-code')).toHaveText(code);
    expect(new URL(await page.locator('#camera-link').inputValue()).hash).toBe(`#${code}`);
    await expect(page.locator('#camera-start')).toHaveText('Resume camera');
    await expect(page.locator('#camera-start')).toBeEnabled();
  });
});

test.describe('remote-camera: native WebRTC media', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(!exists, 'Remote Camera is awaiting the website release.');
    test.skip(browserName !== 'chromium', 'This test build supplies native flowing media reliably in Chromium. Physical Safari remains an acceptance check.');
    test.skip(!await canFakeCamera(page), 'This test engine cannot supply a native canvas camera.'); await withoutThirdParties(page);
  });
  test('Review later keeps a request private until the owner approves it from the list', async ({ page, context, browser }) => {
    test.skip(!approvalPopup, 'Incoming camera request dialogs are awaiting the website release.');
    test.setTimeout(60_000); const broker = localRendezvous(), viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraClipboard(page);
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      await sourcePage(page); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, note = '<img src=x onerror=alert(1)> QA request';
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await cameraHooks(viewer, 'deny', 'broker');
      await requestCamera(viewer, code, note);
      const dialog = page.locator('#camera-request-dialog');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expect(dialog).toHaveAccessibleName('A viewer wants to join');
      await expect(page.locator('#camera-request-later')).toBeFocused();
      await expect(page.locator('#camera-request-note')).toHaveText(note);
      await expect(dialog.locator('img')).toHaveCount(0);
      expect(await viewer.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__remoteCameraRTC.tracks.length])).toEqual([0, 0]);
      expect(await page.evaluate(() => (window as any).__remoteCameraRTC.peers[0].getSenders().every((sender: RTCRtpSender) => !sender.track))).toBe(true);

      await page.locator('#camera-request-later').click(); await expect(dialog).toBeHidden();
      const request = await pendingCameraRequest(page, viewer, note);
      await expect(request.approve).toBeFocused();
      await request.approve.click(); await flowingCamera(viewer);
      await expect(page.locator('#camera-requests [data-action=approve]')).toHaveCount(0);
      await expect(dialog).toBeHidden();
      expect(await viewer.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(0);
      await stopSharedCamera(page); await tracksStopped(page);
      await expect(viewer.locator('#viewer-status')).toContainText('ended');
      if (connectionReports) {
        const text = await copyCameraReport(page), report = JSON.parse(text);
        expect(report.attempts).toHaveLength(1);
        expect(report.attempts[0]).toMatchObject({ role: 'sharer', finished: true, outcome: 'stopped' });
        expect(report.attempts[0].signaling.offerSent).toBeGreaterThan(0);
        expect(report.attempts[0].candidates.local.count).toBeGreaterThan(0);
        for (const secret of [code, note, 'candidate:', 'v=0', 'a=ice-ufrag', 'a=fingerprint', '"sdp"']) expect(text).not.toContain(secret);
        expect(await copyCameraReport(page)).toBe(text);
      }
    } finally { await viewerContext.close(); }
  });
  test('request popup Escape, denial, departure and Stop preserve each viewer consent boundary', async ({ page, context, browser }) => {
    test.skip(!approvalPopup, 'Incoming camera request dialogs are awaiting the website release.');
    test.setTimeout(90_000); const broker = localRendezvous(), viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      await sourcePage(page); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, invitation = await page.locator('#camera-link').inputValue();
      const watching = await viewerContext.newPage(); await withoutThirdParties(watching); await cameraHooks(watching, 'deny', 'broker');
      await requestCamera(watching, code, 'QA approved sibling');
      const dialog = page.locator('#camera-request-dialog');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await page.locator('#camera-request-approve').click(); await expect(dialog).toBeHidden(); await flowingCamera(watching);
      await watching.evaluate(() => { (window as any).__popupSiblingPeer = (window as any).__remoteCameraRTC.peers[0]; });

      const escaped = await viewerContext.newPage(); await withoutThirdParties(escaped); await cameraHooks(escaped, 'deny', 'broker');
      await requestCamera(escaped, code, 'QA Escape remains pending'); await expect(dialog).toBeVisible({ timeout: 20_000 });
      await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
      const pending = await pendingCameraRequest(page, escaped, 'QA Escape remains pending');
      await expect(pending.approve).toBeFocused();
      await page.locator(`[data-action=deny][data-peer="${pending.id}"]`).click();
      await expect(escaped.locator('#viewer-status')).toContainText('turned away');
      expect(await escaped.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__remoteCameraRTC.tracks.length])).toEqual([0, 0]);
      await flowingCamera(watching); await expect(dialog).toBeHidden();

      const refused = await viewerContext.newPage(); await withoutThirdParties(refused); await cameraHooks(refused, 'deny', 'broker');
      await requestCamera(refused, code, 'QA popup refusal'); await expect(dialog).toBeVisible({ timeout: 20_000 });
      await page.locator('#camera-request-deny').click(); await expect(dialog).toBeHidden();
      await expect(refused.locator('#viewer-status')).toContainText('turned away');
      expect(await refused.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__remoteCameraRTC.tracks.length])).toEqual([0, 0]);

      const leaving = await viewerContext.newPage(); await withoutThirdParties(leaving); await cameraHooks(leaving, 'deny', 'broker');
      await requestCamera(leaving, code, 'QA departed request'); await expect(dialog).toBeVisible({ timeout: 20_000 });
      await leaving.locator('#viewer-stop').click(); await expect(dialog).toBeHidden();
      await expect(page.locator('#camera-requests [data-action=approve]')).toHaveCount(0);
      await flowingCamera(watching); await expect(page.locator('#camera-link')).toHaveValue(invitation);
      expect(await watching.evaluate(() => (window as any).__remoteCameraRTC.peers.length === 1
        && (window as any).__remoteCameraRTC.peers[0] === (window as any).__popupSiblingPeer)).toBe(true);

      const waiting = await viewerContext.newPage(); await withoutThirdParties(waiting); await cameraHooks(waiting, 'deny', 'broker');
      await requestCamera(waiting, code, 'QA pending at Stop'); await expect(dialog).toBeVisible({ timeout: 20_000 });
      await stopSharedCamera(page); await tracksStopped(page); await expect(dialog).toBeHidden();
      await expect(page.locator('#camera-requests [data-action=approve]')).toHaveCount(0);
      await expect(watching.locator('#viewer-status')).toContainText('ended');
      await expect(waiting.locator('#viewer-status')).toContainText('ended');
      expect(await waiting.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__remoteCameraRTC.tracks.length])).toEqual([0, 0]);
    } finally { await viewerContext.close(); }
  });
  test('a missing remote offer leaves a retained address-free handshake-timeout report', async ({ page, context }) => {
    test.skip(!connectionReports, 'Camera connection reports are awaiting the website release.');
    test.setTimeout(60_000); const broker = localRendezvous();
    await cameraClipboard(page); await cameraHooks(page, 'deny', 'broker'); await broker.install(context);
    const code = 'qa-report-secret-room', note = 'QA-private-viewer-note-82ae', address = '192.0.2.42';
    const protocol = fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/remote-camera/src/protocol.js'), 'utf8')
      .match(/export const PROTOCOL = '([^']+)'/)?.[1];
    expect(protocol).toBeTruthy();
    await requestCamera(page, code, note);
    await expect.poll(() => page.evaluate(() => [...(window as any).__remoteCameraSockets.values()]
      .some((socket: any) => !socket.discovery && socket.readyState === 1))).toBe(true);
    // A reachable introduction service announces a host which never supplies
    // an offer. The real, unnegotiated peer must time out without any capture.
    await page.evaluate(({ protocol, address }) => {
      const socket = [...(window as any).__remoteCameraSockets.values()].find((socket: any) => !socket.discovery) as any;
      socket.receive({ type: 'ready' });
      socket.receive({ type: 'signal', data: { protocol, candidate: {
        candidate: `candidate:1 1 udp 2122260223 ${address} 54321 typ srflx`, sdpMid: '0', sdpMLineIndex: 0,
      } } });
    }, { protocol, address });
    await expect.poll(() => page.evaluate(() => (window as any).__remoteCameraRTC.peers.length)).toBe(1);
    await expect(page.locator('#viewer-stop')).toBeHidden({ timeout: 25_000 });
    await expect(page.locator('#viewer-connect')).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__remoteCameraRTC.peers[0].connectionState)).toBe('closed');
    const text = await copyCameraReport(page), report = JSON.parse(text);
    expect(report).toMatchObject({ schema: 1, tool: 'remote-camera', attemptsDropped: 0 });
    expect(report.toolVersion).toBe(await page.locator('[data-pairing-version]').getAttribute('data-pairing-version'));
    expect(report.browser.family).toBe('Chrome'); expect(report.attempts).toHaveLength(1);
    const attempt = report.attempts[0];
    expect(attempt).toMatchObject({ role: 'receiver', mode: 'local', stage: 'room-ready', finished: true, outcome: 'handshake-timeout',
      signaling: { offerReceived: 0, answerSent: 0, candidatesReceived: 1, candidatesAccepted: 0, candidatesFiltered: 1 } });
    expect(attempt.milestonesMs).toHaveProperty('room-ready');
    expect(attempt.states.connection).toBe('new');
    expect(attempt.candidates.remote).toMatchObject({ types: { srflx: 2 }, addressForms: { ipv4: 2 }, results: { received: 1, filtered: 1 } });
    for (const secret of [code, note, address, 'candidate:1', 'sdpMid', 'sdpMLineIndex', 'v=0', 'a=ice-ufrag', 'a=fingerprint']) expect(text).not.toContain(secret);
    expect(await page.evaluate(() => [(window as any).__cameraQA.calls.length, (window as any).__remoteCameraRTC.tracks.length])).toEqual([0, 0]);

    await page.evaluate(() => {
      (window as any).__cameraClipboard.denied = true;
      (window as any).__remoteCameraRTC.peers[0].dispatchEvent(new Event('connectionstatechange'));
    });
    expect(await copyCameraReport(page)).toBe(text);
    await expect(page.locator('#connection-report')).toHaveValue(text);
    expect(JSON.parse(await downloadCameraReport(page))).toEqual(report);
    expect(await page.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => !socket.discovery)
      .every((socket: any) => socket.readyState === 3))).toBe(true);
  });
  test('approved audio plays when permitted and muted playback keeps sound alerts and camera switching', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous();
    const viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await notificationHooks(viewer, 'granted'); await sourcePage(page);
      const audio = page.locator('#camera-audio');
      test.skip(await audio.count() === 0, 'Camera audio is awaiting the website release.');
      await expect(audio).not.toBeChecked(); await audio.check();
      await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      await expect(audio).toBeDisabled();
      expect(await page.evaluate(() => (window as any).__cameraQA.calls[0])).toEqual({ video: true, audio: true });
      const code = (await page.locator('#camera-code').textContent())!;
      await cameraHooks(viewer, 'deny', 'broker'); await requestCamera(viewer, code, 'QA audio viewer');
      await expect(page.locator('[data-action=approve]')).toBeVisible({ timeout: 20_000 });
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
      expect(await page.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.getSenders().every((sender) => !sender.track)))).toBe(true);
      await expect(viewer.locator('#viewer-listen')).toBeHidden();
      await reviewCameraRequestLater(page);
      await page.locator('[data-action=approve]').click();
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(640);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks().map((track) => track.kind).sort())).toEqual(['audio', 'video']);
      const listen = viewer.locator('#viewer-listen');
      await expect(listen).toBeVisible();
      const overlay = await viewer.locator('#viewer-video-frame').count() > 0;
      if (!overlay) {
        expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
        await expect(listen).toHaveAttribute('aria-pressed', 'false'); await listen.click();
      }
      await expect(listen).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(false);
      await expect.poll(() => viewer.evaluate(async () => {
        const report = await (window as any).__remoteCameraRTC.peers.at(-1).getStats();
        return [...report.values()].filter((entry: any) => entry.type === 'inbound-rtp' && entry.kind === 'audio')
          .reduce((bytes: number, entry: any) => bytes + (entry.bytesReceived ?? 0), 0);
      })).toBeGreaterThan(0);
      await listen.click(); await expect(listen).toHaveAttribute('aria-pressed', 'false');
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
      await viewerOverlay(viewer, true);
      await expect(viewer.locator('#viewer-alert-options')).toBeVisible({ timeout: 20_000 });
      await expect(viewer.locator('#viewer-motion-alert')).not.toBeChecked();
      await expect(viewer.locator('#viewer-sound-alert')).not.toBeChecked();
      await expect(viewer.locator('#viewer-sound-alert')).toBeEnabled();
      expect(await viewer.evaluate(() => (window as any).__cameraNotifications.requests)).toBe(0);
      if (overlay) for (const id of ['viewer-audio-help', 'viewer-alert-help']) await viewerHelp(viewer, id);
      await viewer.locator('#viewer-sound-alert').check();
      await expect.poll(() => viewer.evaluate(() => (window as any).__cameraNotifications.requests)).toBe(1);
      await expect.poll(() => viewer.evaluate(() => (window as any).__cameraNotifications.shown.some((entry: any) => entry.options.body.includes('Sound was detected'))), { timeout: 20_000 }).toBe(true);
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
      await expect(viewer.locator('#viewer-motion-alert')).not.toBeChecked();
      await expect(viewer.locator('#viewer-sound-alert')).toBeChecked(); await expect(viewer.locator('#viewer-sound-alert')).toBeEnabled();
      await page.evaluate(() => {
        (window as any).__audioBeforeSwitch = ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks()[0];
        (window as any).__audioSenderBeforeSwitch = (window as any).__remoteCameraRTC.peers.at(-1).getSenders().find((sender: RTCRtpSender) => sender.track?.kind === 'audio');
      });
      await page.locator('#camera-device').selectOption('qa-camera-2');
      await expect(page.locator('#camera-switch-status')).toContainText('Camera switched');
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(320);
      expect(await page.evaluate(() => {
        const track = (window as any).__audioBeforeSwitch, sender = (window as any).__audioSenderBeforeSwitch;
        return track.readyState === 'live' && ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks()[0] === track
          && (window as any).__remoteCameraRTC.peers.at(-1).getSenders().includes(sender) && sender.track === track;
      })).toBe(true);
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
      await expect(listen).toHaveAttribute('aria-pressed', 'false');
      await expect(viewer.locator('#viewer-sound-alert')).toBeChecked(); await expect(viewer.locator('#viewer-sound-alert')).toBeEnabled();
      await viewer.locator('#viewer-motion-alert').check();
      expect(await viewer.evaluate(() => (window as any).__cameraNotifications.requests)).toBe(1);
      expect(await viewer.evaluate(() => (window as any).__cameraNotifications.shown.every((entry: any) => new URL(entry.scope).pathname === '/remote-camera/'))).toBe(true);
      await stopSharedCamera(page); await tracksStopped(page);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
      await expect(viewer.locator('#viewer-motion-alert')).not.toBeChecked();
      await expect(viewer.locator('#viewer-sound-alert')).not.toBeChecked();
      const notices = await viewer.evaluate(() => (window as any).__cameraNotifications.shown.length);
      await viewer.waitForTimeout(500);
      expect(await viewer.evaluate(() => (window as any).__cameraNotifications.shown.length)).toBe(notices);
    } finally { await viewerContext.close(); }
  });
  test('blocked automatic audio falls back to flowing muted video and a viewer can unmute', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous(), viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await sourcePage(page);
      test.skip(await page.locator('#viewer-video-frame').count() === 0, 'Automatic audio is awaiting the website release.');
      await viewer.addInitScript(() => {
        const state = (window as any).__cameraAutoplay = { blocked: 0, reject: true }, play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (this.id === 'remote-video' && !this.muted && (this.srcObject as MediaStream | null)?.getAudioTracks().length && state.reject) {
            state.blocked++; return Promise.reject(new DOMException('Audio autoplay blocked', 'NotAllowedError'));
          }
          return play.call(this);
        };
      });
      await page.locator('#camera-audio').check(); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!;
      await cameraHooks(viewer, 'deny', 'broker'); await requestCamera(viewer, code, 'QA blocked autoplay');
      await expect(page.locator('[data-action=approve]')).toBeVisible({ timeout: 20_000 });
      await reviewCameraRequestLater(page); await page.locator('[data-action=approve]').click();
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.videoWidth), { timeout: 20_000 }).toBe(640);
      await expect.poll(() => viewer.evaluate(() => (window as any).__cameraAutoplay.blocked)).toBeGreaterThan(0);
      await expect(viewer.locator('#viewer-listen')).toHaveAttribute('aria-pressed', 'false'); await expect(viewer.locator('#viewer-play')).toBeHidden();
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
      const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(first + 2);
      await viewer.evaluate(() => { (window as any).__cameraAutoplay.reject = false; }); await viewer.locator('#viewer-listen').click();
      await expect(viewer.locator('#viewer-listen')).toHaveAttribute('aria-pressed', 'true');
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(false);
      await stopSharedCamera(page); await tracksStopped(page);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
    } finally { await viewerContext.close(); }
  });
  test('three viewers have independent consent, video budgets, microphone playback and host disconnect controls', async ({ page, context, browser }) => {
    test.setTimeout(120_000); const broker = localRendezvous(), viewerContexts: BrowserContext[] = [];
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await sourcePage(page);
      test.skip(await page.locator('#camera-bandwidth').count() === 0, 'Multiple camera viewers are awaiting the website release.');
      await expect(page.locator('#camera-bandwidth')).toHaveValue('6');
      await page.locator('#camera-audio').check(); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, invitation = await page.locator('#camera-link').inputValue();
      const viewers: Page[] = [], ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const viewerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined }); viewerContexts.push(viewerContext);
        await broker.install(viewerContext); const viewer = await viewerContext.newPage(); viewers.push(viewer);
        await withoutThirdParties(viewer); await cameraHooks(viewer, 'deny', 'broker');
        if (index === 0) await notificationHooks(viewer, 'granted');
        if (index === 1) await holdCameraApprovalAck(viewer);
        const name = `QA independent viewer ${index + 1}`;
        await requestCamera(viewer, code, name); const request = await pendingCameraRequest(page, viewer, name); ids.push(request.id);
        await request.approve.click();
        if (index === 1) {
          await expect.poll(() => viewer.evaluate(() => (window as any).__cameraAck.held)).toBe(true);
          expect(await page.evaluate((peer) => (window as any).__remoteCameraRTC.peers[peer].getSenders().every((sender: RTCRtpSender) => !sender.track), request.peer)).toBe(true);
          expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
          await flowingCamera(viewers[0], true);
          await viewer.evaluate(() => (window as any).__cameraAck.release());
        }
        await flowingCamera(viewer, true);
        await expect(page.locator('#camera-viewer-list [data-action=disconnect]')).toHaveCount(index + 1);
      }
      await expect(page.locator('#camera-viewer-count')).toContainText('3');
      await boundedVideoSenders(page, 3, 6_000_000);
      await page.locator('#camera-bandwidth').selectOption('1');
      const lowCaps = await boundedVideoSenders(page, 3, 1_000_000);
      await expect(page.locator('#camera-viewer-count')).toContainText('4');
      await page.locator('#camera-bandwidth').selectOption('2');
      await expect.poll(async () => (await videoSenderCaps(page))[0]).toBeGreaterThan(lowCaps[0]);
      const threeCaps = await boundedVideoSenders(page, 3, 2_000_000);
      await expect(page.locator('#camera-bandwidth-status')).toBeVisible();

      const first = viewers[0], listen = first.locator('#viewer-listen');
      await expect(listen).toBeVisible();
      if (await listen.getAttribute('aria-pressed') === 'true') await listen.click();
      expect(await first.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
      await expect(first.locator('#viewer-sound-alert')).toBeEnabled({ timeout: 20_000 }); await first.locator('#viewer-sound-alert').check();
      await expect.poll(() => first.evaluate(() => (window as any).__cameraNotifications.shown.some((entry: any) => entry.options.body.includes('Sound was detected'))), { timeout: 20_000 }).toBe(true);
      await page.evaluate(() => {
        const stream = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream;
        (window as any).__multiVideoBefore = stream.getVideoTracks()[0]; (window as any).__multiAudioBefore = stream.getAudioTracks()[0];
        (window as any).__multiAudioSenders = (window as any).__remoteCameraRTC.peers.map((peer: RTCPeerConnection) => peer.getSenders().find((sender) => sender.track?.kind === 'audio'));
      });
      await page.locator('#camera-device').selectOption('qa-camera-2'); await expect(page.locator('#camera-switch-status')).toContainText('Camera switched');
      for (const viewer of viewers) await flowingCamera(viewer, true, null);
      expect(await page.evaluate(() => {
        const stream = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream, microphone = (window as any).__multiAudioBefore;
        return (window as any).__multiVideoBefore.readyState === 'ended' && microphone.readyState === 'live' && stream.getAudioTracks()[0] === microphone
          && (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection, index: number) => peer.getSenders().includes((window as any).__multiAudioSenders[index])
            && (window as any).__multiAudioSenders[index].track === microphone
            && peer.getSenders().find((sender) => sender.track?.kind === 'video')?.track === stream.getVideoTracks()[0])
          && stream.getVideoTracks()[0].getSettings().deviceId === 'qa-camera-2';
      })).toBe(true);
      expect(await first.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(true);
      await expect(first.locator('#viewer-sound-alert')).toBeChecked(); await expect(first.locator('#viewer-sound-alert')).toBeEnabled();
      await page.locator(`#camera-viewer-list [data-action=disconnect][data-peer="${ids[1]}"]`).click();
      await expect(viewers[1].locator('#viewer-status')).toContainText('ended');
      await expect.poll(() => viewers[1].locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewers[1].evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
      await expect(page.locator('#camera-viewer-list [data-action=disconnect]')).toHaveCount(2);
      await expect.poll(async () => (await videoSenderCaps(page))[0]).toBeGreaterThan(threeCaps[0]); await boundedVideoSenders(page, 2, 2_000_000);
      for (const viewer of [viewers[0], viewers[2]]) await flowingCamera(viewer, true, null);
      await expect(page.locator('#camera-link')).toHaveValue(invitation);
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(2);
      await stopSharedCamera(page); await tracksStopped(page);
      for (const viewer of viewers) await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
    } finally { for (const viewerContext of viewerContexts) await viewerContext.close(); }
  });
  test('introduction and quiet microphone recovery preserve every viewer and independent leaving', async ({ page, context, browser }) => {
    test.setTimeout(120_000); const broker = localRendezvous(), viewerContexts: BrowserContext[] = [];
    try {
      await cameraClipboard(context);
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await sourcePage(page);
      test.skip(await page.locator('#camera-bandwidth').count() === 0, 'Multiple camera viewers are awaiting the website release.');
      await page.locator('#camera-audio').check(); await page.locator('#camera-start').click(); await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, invitation = await page.locator('#camera-link').inputValue(), viewers: Page[] = [];
      for (let index = 0; index < 2; index++) {
        const viewerContext = await browser.newContext({ baseURL: BASE_URL }); viewerContexts.push(viewerContext);
        await cameraClipboard(viewerContext); await broker.install(viewerContext);
        const viewer = await viewerContext.newPage(); viewers.push(viewer); await withoutThirdParties(viewer); await cameraHooks(viewer, 'deny', 'broker');
        const name = `QA retained viewer ${index + 1}`; await requestCamera(viewer, code, name);
        const request = await pendingCameraRequest(page, viewer, name); await request.approve.click(); await flowingCamera(viewer, true);
        await viewer.evaluate(() => {
          (window as any).__multiRemoteBefore = (document.querySelector('#remote-video') as HTMLVideoElement).srcObject;
          (window as any).__multiPeerBefore = (window as any).__remoteCameraRTC.peers.at(-1);
        });
      }
      await page.evaluate(() => {
        (window as any).__multiCaptureBefore = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject;
        (window as any).__multiHostPeersBefore = [...(window as any).__remoteCameraRTC.peers];
      });
      for (const viewer of viewers) await viewer.evaluate(() => {
        for (const socket of (window as any).__remoteCameraSockets.values()) if (!socket.discovery && socket.readyState === 1) socket.remoteClose(4410);
      });
      await page.evaluate(() => {
        for (const socket of (window as any).__remoteCameraSockets.values()) if (!socket.discovery && socket.readyState === 1) socket.remoteClose(1006);
      });
      await expect.poll(() => page.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => !socket.discovery && socket.readyState === 1).length), { timeout: 20_000 }).toBe(1);
      await expect(page.locator('#camera-viewer-list [data-action=disconnect]')).toHaveCount(2);
      await expect(page.locator('#camera-link')).toHaveValue(invitation);
      expect(await page.evaluate(() => (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject === (window as any).__multiCaptureBefore
        && (window as any).__cameraQA.calls.length === 1 && (window as any).__remoteCameraRTC.peers.length === 2
        && (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection, index: number) => peer === (window as any).__multiHostPeersBefore[index]))).toBe(true);
      for (const viewer of viewers) {
        await flowingCamera(viewer, true);
        expect(await viewer.evaluate(() => (document.querySelector('#remote-video') as HTMLVideoElement).srcObject === (window as any).__multiRemoteBefore
          && (window as any).__remoteCameraRTC.peers.at(-1) === (window as any).__multiPeerBefore)).toBe(true);
      }
      // An ended opted-in microphone recovers without replacing healthy video,
      // repeating approval, or enabling speech. These are simulated events.
      await simulateCameraVisibility(page);
      await page.evaluate(() => {
        const stream = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream;
        (window as any).__quietVideo = stream.getVideoTracks()[0];
        (window as any).__quietAudio = stream.getAudioTracks()[0];
        (window as any).__quietSenders = (window as any).__remoteCameraRTC.peers.map((peer: RTCPeerConnection) => peer.getSenders().find((sender) => sender.track?.kind === 'audio'));
        (window as any).__quietSockets = (window as any).__remoteCameraSockets.size;
        (window as any).__setCameraHidden(true);
        (window as any).__quietAudio.stop(); (window as any).__quietAudio.dispatchEvent(new Event('ended'));
      });
      await expect(page.locator('#camera-audio-status')).toHaveText('Microphone interrupted. Resume it when you are ready.');
      await expect(page.locator('#camera-start')).toHaveText('Resume microphone'); await expect(page.locator('#camera-start')).toBeDisabled();
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(1);
      await page.evaluate(() => {
        (window as any).__setCameraHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      });
      await expect(page.locator('#camera-start')).toHaveText('Resume microphone'); await expect(page.locator('#camera-start')).toBeEnabled();
      await expect.poll(() => page.evaluate(() => {
        const stream = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream;
        const audio = stream.getAudioTracks()[0];
        return Boolean(audio && audio !== (window as any).__quietAudio && audio.readyState === 'live' && !audio.enabled
          && stream.getVideoTracks()[0] === (window as any).__quietVideo
          && (window as any).__remoteCameraRTC.peers.length === 2
          && (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection, index: number) =>
            peer === (window as any).__multiHostPeersBefore[index] && peer.connectionState === 'connected'
            && peer.getSenders().includes((window as any).__quietSenders[index]) && (window as any).__quietSenders[index].track === audio)
          && (window as any).__remoteCameraSockets.size === (window as any).__quietSockets);
      })).toBe(true);
      expect(await page.evaluate(() => (window as any).__cameraQA.calls)).toEqual([
        { video: true, audio: true }, { video: false, audio: true },
      ]);
      expect(await page.evaluate(() => (window as any).__cameraQA.tracks.filter((track: MediaStreamTrack) => track.kind === 'video').length)).toBe(1);
      await expect(page.locator('#camera-link')).toHaveValue(invitation); await expect(page.locator('[data-action=approve]')).toHaveCount(0);
      for (const viewer of viewers) {
        await flowingCamera(viewer, true);
        expect(await viewer.evaluate(() => (document.querySelector('#remote-video') as HTMLVideoElement).srcObject === (window as any).__multiRemoteBefore
          && (window as any).__remoteCameraRTC.peers.length === 1
          && (window as any).__remoteCameraRTC.peers[0] === (window as any).__multiPeerBefore)).toBe(true);
        expect(await viewer.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(0);
      }
      const listening = viewers[1], listen = listening.locator('#viewer-listen');
      if (await listen.getAttribute('aria-pressed') !== 'true') await listen.click();
      await expect.poll(() => listening.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.muted)).toBe(false);
      const audioEnergy = () => listening.evaluate(async () => {
        const report = await (window as any).__remoteCameraRTC.peers[0].getStats();
        return [...report.values()].filter((entry: any) => entry.type === 'inbound-rtp' && entry.kind === 'audio')
          .reduce((energy: number, entry: any) => energy + (entry.totalAudioEnergy ?? 0), 0);
      });
      const quietEnergy = await audioEnergy();
      await page.locator('#camera-start').click(); await expect(page.locator('#camera-start')).toBeHidden();
      await expect(page.locator('#camera-audio-status')).toHaveText('Microphone is on. Stop sharing to turn it off.');
      expect(await page.evaluate(() => ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks()[0].enabled)).toBe(true);
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(2);
      await expect.poll(audioEnergy, { timeout: 20_000 }).toBeGreaterThan(quietEnergy);
      await viewers[0].locator('#viewer-stop').click();
      await expect.poll(() => viewers[0].locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect(page.locator('#camera-viewer-list [data-action=disconnect]')).toHaveCount(1); await flowingCamera(viewers[1], true);
      expect(await page.evaluate(() => ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].readyState)).toBe('live');
      // Stop must also retire an audio-only permission grant that arrives late.
      await page.evaluate(() => {
        const state = (window as any).__cameraQA; state.holdNext = true; state.release = null;
        (window as any).__setCameraHidden(true);
        const audio = ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getAudioTracks()[0];
        audio.stop(); audio.dispatchEvent(new Event('ended'));
        (window as any).__setCameraHidden(false);
      });
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__cameraQA.release))).toBe(true);
      await stopSharedCamera(page); await page.evaluate(() => (window as any).__cameraQA.release());
      await expect.poll(() => page.evaluate(() => (window as any).__cameraQA.tracks.length)).toBe(4); await tracksStopped(page);
      await page.evaluate(() => {
        (window as any).__setCameraHidden(true); (window as any).__setCameraHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect(page.locator('#camera-start')).toHaveText('Start camera');
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(3);
      await expect.poll(() => viewers[1].locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
    } catch (error) {
      await attachCameraFailureReports(page, viewerContexts).catch(() => {});
      throw error;
    } finally { for (const viewerContext of viewerContexts) await viewerContext.close(); }
  });
  test('introduction socket interruptions preserve established direct video until Stop', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous(), viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await sourcePage(page);
      test.skip(await page.locator('#viewer-video-frame').count() === 0, 'Introduction recovery is awaiting the website release.');
      await page.locator('#camera-start').click(); await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, invitation = await page.locator('#camera-link').inputValue();
      await cameraHooks(viewer, 'deny', 'broker'); await requestCamera(viewer, code, 'QA introduction interruption'); await approveCamera(page, viewer);
      await viewer.evaluate(() => {
        (window as any).__streamBeforeSocketClose = (document.querySelector('#remote-video') as HTMLVideoElement).srcObject;
        (window as any).__peerBeforeSocketClose = (window as any).__remoteCameraRTC.peers.at(-1);
        for (const socket of (window as any).__remoteCameraSockets.values()) if (!socket.discovery && socket.readyState === 1) socket.remoteClose(4410);
      });
      await page.evaluate(() => {
        (window as any).__captureBeforeSocketClose = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject;
        for (const socket of (window as any).__remoteCameraSockets.values()) if (!socket.discovery && socket.readyState === 1) socket.remoteClose(1006);
      });
      const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 10_000 }).toBeGreaterThan(first + 5);
      expect(await viewer.evaluate(() => {
        const video = document.querySelector('#remote-video') as HTMLVideoElement, peer = (window as any).__peerBeforeSocketClose;
        return video.srcObject === (window as any).__streamBeforeSocketClose && peer === (window as any).__remoteCameraRTC.peers.at(-1)
          && peer.connectionState === 'connected' && (video.srcObject as MediaStream).getTracks().every((track) => track.readyState === 'live');
      })).toBe(true);
      await expect(viewer.locator('#viewer-connect')).toBeHidden(); await expect(viewer.locator('#viewer-stop')).toBeVisible();
      await expect.poll(() => page.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => !socket.discovery && socket.readyState === 1).length), { timeout: 20_000 }).toBe(1);
      expect(await page.evaluate(() => (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject === (window as any).__captureBeforeSocketClose)).toBe(true);
      await expect(page.locator('#camera-link')).toHaveValue(invitation);
      await stopSharedCamera(page); await tracksStopped(page);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
    } finally { await viewerContext.close(); }
  });
  for (const permission of ['denied', 'pending', 'unsupported'] as const) {
    test(`viewer alerts keep video working when notifications are ${permission}`, async ({ page, context, browser }) => {
      test.setTimeout(60_000); const broker = localRendezvous();
      const viewerContext = await browser.newContext({ baseURL: BASE_URL });
      try {
        await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
        const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await notificationHooks(viewer, permission === 'unsupported' ? 'denied' : permission); await sourcePage(page);
        if (permission === 'unsupported') await viewer.addInitScript(() => {
          Object.defineProperty(window, 'Notification', { configurable: true, value: undefined });
        });
        if (permission === 'denied') await viewer.addInitScript(() => {
          Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
          Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
        });
        test.skip(await page.locator('#camera-audio').count() === 0, 'Camera alerts are awaiting the website release.');
        await page.locator('#camera-start').click(); await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
        const code = (await page.locator('#camera-code').textContent())!;
        await cameraHooks(viewer, 'deny', 'broker'); await requestCamera(viewer, code, 'QA alert permission');
        await approveCamera(page, viewer);
        expect(await viewer.evaluate(() => (window as any).__cameraNotifications.requests)).toBe(0);
        if (permission === 'unsupported') {
          await expect.poll(() => viewer.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''), { timeout: 20_000 }).toContain('/remote-camera/sw.js');
          await viewer.waitForTimeout(500);
          await expect(viewer.locator('#viewer-video-panel')).toBeVisible();
          await expect(viewer.locator('#viewer-alert-options')).toBeHidden();
        } else {
          await expect(viewer.locator('#viewer-alert-options')).toBeVisible({ timeout: 20_000 });
          // Permission denial intentionally clears the checkbox during the click.
          if (permission === 'denied') await viewer.locator('#viewer-motion-alert').click();
          else await viewer.locator('#viewer-motion-alert').check();
          await expect.poll(() => viewer.evaluate(() => (window as any).__cameraNotifications.requests)).toBe(1);
        }
        if (permission === 'denied') {
          await expect(viewer.locator('#viewer-sound-option')).toBeHidden();
          await expect(viewer.locator('#viewer-alert-status')).toContainText('Notifications were not allowed');
          await expect(viewer.locator('#viewer-motion-alert')).not.toBeChecked();
          const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
          await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(first + 2);
        }
        await viewer.locator('#viewer-stop').click();
        await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
        if (permission === 'pending') await viewer.evaluate(() => (window as any).__cameraNotifications.release('granted'));
        await expect(viewer.locator('#viewer-motion-alert')).not.toBeChecked();
        await expect(viewer.locator('#viewer-sound-alert')).not.toBeChecked();
        await viewer.waitForTimeout(500);
        await expect(viewer.locator('#viewer-motion-alert')).not.toBeChecked();
        await expect(viewer.locator('#viewer-sound-alert')).not.toBeChecked();
        expect(await viewer.evaluate(() => [(window as any).__cameraNotifications.requests, (window as any).__cameraNotifications.shown.length])).toEqual([permission === 'unsupported' ? 0 : 1, 0]);
        await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
        await page.locator('#camera-stop').click(); await tracksStopped(page);
      } finally { await viewerContext.close(); }
    });
  }
  test('simulated visibility keeps approved video and resumes ended capture without reviving Stop', async ({ page, context, browser }) => {
    test.skip(!captureRecovery, 'Camera capture recovery is awaiting the website release.');
    test.setTimeout(60_000); const broker = localRendezvous();
    const viewerContext = await browser.newContext({ baseURL: BASE_URL });
    // These events exercise browser lifecycle handling with real media and RTC.
    // They do not reproduce a physical phone's lock or background restrictions.
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await cameraHooks(viewer, 'deny', 'broker');
      await sourcePage(page); await expect(page.locator('#camera-require-approval')).toBeChecked(); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, invitation = await page.locator('#camera-link').inputValue();
      await requestCamera(viewer, code, 'QA continuity viewer'); await approveCamera(page, viewer);
      await simulateCameraVisibility(page); await simulateCameraVisibility(viewer);
      await page.evaluate(() => {
        const video = document.querySelector('#camera-preview') as HTMLVideoElement;
        (window as any).__cameraContinuity = {
          peer: (window as any).__remoteCameraRTC.peers[0], track: (video.srcObject as MediaStream).getVideoTracks()[0],
          sockets: (window as any).__remoteCameraSockets.size,
        };
        (window as any).__setCameraHidden(true);
      });
      await viewer.evaluate(() => {
        (window as any).__originalViewerPeer = (window as any).__remoteCameraRTC.peers[0];
        (window as any).__setCameraHidden(true);
      });
      await expect(page.locator('#camera-start')).toBeHidden(); await expect(page.locator('#camera-link')).toHaveValue(invitation);
      expect(await page.evaluate(() => {
        const original = (window as any).__cameraContinuity;
        const track = ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0];
        return track === original.track && track.readyState === 'live' && original.peer.connectionState === 'connected'
          && (window as any).__remoteCameraRTC.peers.length === 1 && (window as any).__remoteCameraSockets.size === original.sockets
          && (window as any).__cameraQA.calls.length === 1;
      })).toBe(true);
      const hiddenFrames = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(hiddenFrames + 2);
      await page.evaluate(() => (window as any).__setCameraHidden(false)); await viewer.evaluate(() => (window as any).__setCameraHidden(false));
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(1);

      await page.evaluate(() => {
        (window as any).__setCameraHidden(true);
        const track = (window as any).__cameraContinuity.track as MediaStreamTrack;
        track.stop(); track.dispatchEvent(new Event('ended'));
      });
      await expect(page.locator('#camera-status')).toContainText('Your browser paused the camera');
      await expect(page.locator('#camera-start')).toHaveText('Resume camera'); await expect(page.locator('#camera-start')).toBeDisabled();
      await expect(page.locator('#camera-link')).toHaveValue(invitation);
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(1);
      await page.evaluate(() => {
        (window as any).__setCameraHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect(page.locator('#camera-start')).toBeHidden();
      await expect.poll(() => page.evaluate(() => {
        const original = (window as any).__cameraContinuity;
        const track = ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream | null)?.getVideoTracks()[0];
        return Boolean(track && track !== original.track && track.readyState === 'live'
          && original.peer.getSenders().some((sender: RTCRtpSender) => sender.track === track));
      })).toBe(true);
      expect(await page.evaluate(() => (window as any).__cameraQA.calls)).toEqual([
        { video: true, audio: false }, { video: { deviceId: { exact: 'qa-camera-1' } }, audio: false },
      ]);
      expect(await page.evaluate(() => {
        const original = (window as any).__cameraContinuity, peers = (window as any).__remoteCameraRTC.peers;
        return peers.length === 1 && peers[0] === original.peer && original.peer.connectionState === 'connected'
          && (window as any).__remoteCameraSockets.size === original.sockets;
      })).toBe(true);
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.length === 1
        && (window as any).__remoteCameraRTC.peers[0] === (window as any).__originalViewerPeer)).toBe(true);
      await expect(page.locator('[data-action=approve]')).toHaveCount(0); await expect(page.locator('#camera-link')).toHaveValue(invitation);
      const recoveredFrames = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(recoveredFrames + 2);

      // A Room leave is a lost viewer socket, not proof its direct peer ended.
      await viewer.evaluate(() => {
        const socket = [...(window as any).__remoteCameraSockets.values()].find((socket: any) => !socket.discovery && socket.readyState === 1) as any;
        if (!socket) throw new Error('The viewer has no room socket.');
        socket.close();
      });
      await expect(viewer.locator('#viewer-status')).toContainText('Pairing is unavailable');
      let continuedFrames = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(continuedFrames + 2);
      await page.evaluate(() => {
        (window as any).__setCameraHidden(true);
        const socket = [...(window as any).__remoteCameraSockets.values()].find((socket: any) => !socket.discovery && socket.readyState === 1) as any;
        if (!socket) throw new Error('The camera has no room socket.');
        socket.close();
      });
      await expect(page.locator('#camera-status')).toContainText('Pairing is unavailable');
      await expect(page.locator('#camera-start')).toHaveText('Restore pairing');
      await expect(page.locator('#camera-start')).toBeDisabled();
      continuedFrames = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(continuedFrames + 2);
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(2);
      await page.evaluate(() => {
        (window as any).__setCameraHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      });
      await expect(page.locator('#camera-start')).toBeHidden();
      expect(await page.evaluate(() => {
        const original = (window as any).__cameraContinuity;
        return original.peer.connectionState === 'connected' && (window as any).__remoteCameraRTC.peers.length === 1
          && (window as any).__remoteCameraSockets.size === original.sockets + 1 && (window as any).__cameraQA.calls.length === 2;
      })).toBe(true);
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.length === 1
        && (window as any).__originalViewerPeer.connectionState === 'connected')).toBe(true);
      await expect(page.locator('#camera-link')).toHaveValue(invitation);
      await expect(page.locator('[data-action=approve]')).toHaveCount(0);

      await page.evaluate(() => {
        const state = (window as any).__cameraQA; state.holdNext = true; state.release = null;
        (window as any).__setCameraHidden(true);
        const track = ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0];
        track.stop(); track.dispatchEvent(new Event('ended'));
        (window as any).__setCameraHidden(false);
      });
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__cameraQA.release))).toBe(true);
      await expect(page.locator('#camera-start')).toBeDisabled(); await stopSharedCamera(page);
      await expect(page.locator('#camera-code')).toBeEmpty(); await expect(page.locator('#camera-invite')).toBeHidden();
      await page.evaluate(() => (window as any).__cameraQA.release());
      await expect.poll(() => page.evaluate(() => (window as any).__cameraQA.tracks.length)).toBe(3); await tracksStopped(page);
      await expect.poll(() => page.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
      await expect(viewer.locator('#viewer-status')).toContainText('ended');
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
      await page.evaluate(() => {
        (window as any).__setCameraHidden(true); (window as any).__setCameraHidden(false);
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await expect(page.locator('#camera-start')).toHaveText('Start camera'); await expect(page.locator('#camera-start')).toBeEnabled();
      expect(await page.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(3);
      expect(await page.evaluate(() => [...(window as any).__remoteCameraSockets.values()].filter((socket: any) => !socket.discovery).every((socket: any) => socket.readyState === 3))).toBe(true);
      expect(await viewer.evaluate(() => (window as any).__cameraQA.calls.length)).toBe(0);
    } finally { await viewerContext.close(); }
  });
  test('optional approval and camera switching preserve the invitation and active peer', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous();
    const viewerContext = await browser.newContext({ baseURL: BASE_URL });
    try {
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await sourcePage(page);
      await page.locator('#camera-require-approval').uncheck(); await expect(page.locator('#camera-approval-policy')).toContainText('Anyone');
      await page.locator('#camera-start').click(); await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/);
      const code = (await page.locator('#camera-code').textContent())!, invite = await page.locator('#camera-link').inputValue();
      await cameraHooks(viewer, 'deny', 'broker'); await requestListedCamera(viewer, code, 'Automatic viewer');
      await expect.poll(() => viewer.locator('#remote-video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBe(640);
      await expect(page.locator('#camera-approval')).toBeHidden();
      await page.evaluate(() => {
        (window as any).__originalCameraPeer = (window as any).__remoteCameraRTC.peers[0];
        (window as any).__originalCameraTrack = (document.querySelector('#camera-preview') as HTMLVideoElement).srcObject && ((document.querySelector('#camera-preview') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0];
        (window as any).__originalSocketCount = (window as any).__remoteCameraSockets.size;
      });
      await expect(page.locator('#camera-device-field')).toBeVisible(); await page.locator('#camera-device').selectOption('qa-camera-2');
      await expect(page.locator('#camera-switch-status')).toContainText('Camera switched');
      await expect.poll(() => viewer.locator('#remote-video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 20_000 }).toBe(320);
      expect(await page.evaluate(() => (window as any).__originalCameraTrack.readyState)).toBe('ended');
      expect(await page.evaluate(() => (window as any).__remoteCameraRTC.peers.length === 1 && (window as any).__remoteCameraRTC.peers[0] === (window as any).__originalCameraPeer && (window as any).__remoteCameraSockets.size === (window as any).__originalSocketCount)).toBe(true);
      await expect(page.locator('#camera-link')).toHaveValue(invite);
      const first = await viewer.locator('#remote-video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(first + 2);
      await page.locator('#camera-require-approval').check();
      expect(await viewer.locator('#remote-video').evaluate((v: HTMLVideoElement) => v.srcObject !== null)).toBe(true);
      await viewer.locator('#viewer-stop').click(); await requestCamera(viewer, code, 'Approval required again');
      await expect(page.locator('[data-action=approve]')).toBeVisible({ timeout: 20_000 });
      expect(await viewer.locator('#remote-video').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
      await reviewCameraRequestLater(page);
      await page.locator('[data-action=deny]').click(); await expect(viewer.locator('#viewer-status')).toContainText('turned away');
      await page.evaluate(() => { (window as any).__cameraQA.holdNext = true; });
      await page.locator('#camera-device').selectOption('qa-camera-1');
      await expect.poll(() => page.evaluate(() => Boolean((window as any).__cameraQA.release))).toBe(true);
      await page.locator('#camera-stop').click(); await page.evaluate(() => (window as any).__cameraQA.release());
      await tracksStopped(page); await expect(page.locator('#camera-start')).toBeEnabled();
    } finally { await viewerContext.close(); }
  });
  test('approval gates video, denial sends none, and additional viewers follow the shipped admission policy', async ({ page, context, browser }) => {
    test.setTimeout(60_000); const broker = localRendezvous();
    const viewerContext = await browser.newContext({ baseURL: BASE_URL, viewport: page.viewportSize() ?? undefined });
    try {
      await cameraClipboard(context); await cameraClipboard(viewerContext);
      await cameraHooks(page, 'allow', 'broker'); await broker.install(context); await broker.install(viewerContext);
      const viewer = await viewerContext.newPage(); await withoutThirdParties(viewer); await sourcePage(page);
      await page.locator('#camera-name').fill('QA Camera Room'); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText('qa-camera-room'); const code = (await page.locator('#camera-code').textContent())!;
      const invitation = await page.locator('#camera-link').inputValue(); expect(new URL(invitation).hash).toBe(`#${code}`);
      await cameraHooks(viewer, 'deny', 'broker'); await requestListedCamera(viewer, code, '<img src=x onerror=alert(1)>'); await expect(page.locator('[data-action=deny]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#camera-requests')).toContainText('<img src=x onerror=alert(1)>'); await expect(page.locator('#camera-requests img')).toHaveCount(0);
      expect(await viewer.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
      await cancelCameraStop(page, viewer, true);
      await page.locator('[data-action=deny]').click(); await expect(viewer.locator('#viewer-status')).toContainText('turned away');
      expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
      await requestCamera(viewer, code, 'QA approved viewer', invitation); await approveCamera(page, viewer);
      const extra = await viewerContext.newPage(); await withoutThirdParties(extra); await requestCamera(extra, code, 'QA other viewer');
      if (await page.locator('#camera-bandwidth').count()) {
        const request = await pendingCameraRequest(page, extra, 'QA other viewer');
        await page.locator(`[data-action=deny][data-peer="${request.id}"]`).click(); await expect(extra.locator('#viewer-status')).toContainText('turned away');
        await flowingCamera(viewer);
      } else {
        await expect(extra.locator('#viewer-status')).toContainText('already has a viewer'); expect(await extra.evaluate(() => (window as any).__remoteCameraRTC.tracks.length)).toBe(0);
      }
      await viewer.locator('#viewer-stop').click(); await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
      await page.locator('#camera-stop').click(); await tracksStopped(page);
    } catch (error) {
      await attachCameraFailureReports(page, [viewerContext]).catch(() => {});
      throw error;
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
    const endpoint = new URL(liveRendezvous('tools/remote-camera/src/session.js')).origin;
    const frames: string[] = [];
    const watch = (page: Page) => page.on('websocket', (socket) => {
      if (new URL(socket.url()).origin !== endpoint) return;
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
    let observedViewer: Page | undefined;
    try {
      await cameraClipboard(context); await cameraClipboard(viewerContext);
      await observePairing(context); await observePairing(viewerContext);
      await monitor(context); await monitor(viewerContext); await cameraHooks(page, 'allow', 'live'); watch(page);
      const viewer = await viewerContext.newPage(); observedViewer = viewer; await withoutThirdParties(viewer); watch(viewer);
      await sourcePage(page); await page.locator('#camera-start').click();
      await expect(page.locator('#camera-code')).toHaveText(/^cam-[a-z2-7]{12}$/, { timeout: 20_000 });
      const code = (await page.locator('#camera-code').textContent())!, note = 'QA-camera-note-kept-off-signaling-7f3e';
      await viewer.goto(`${TOOL}#${code}`); await viewer.locator('#viewer-name').fill(note); await viewer.locator('#viewer-connect').click();
      await approveCamera(page, viewer);
      expect(frames.some((frame) => frame.includes('"description"')), 'The captured traffic must contain actual negotiation.').toBe(true);
      expect(frames.length).toBeGreaterThan(4);
      expect(frames.every((frame) => !frame.includes(note)), 'The note must travel the encrypted peer channel.').toBe(true);
      await cancelCameraStop(page, viewer);
      await stopSharedCamera(page); await tracksStopped(page);
      await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
      await expect.poll(() => viewer.evaluate(() => (window as any).__remoteCameraRTC.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
    } catch (error) {
      await attachCameraFailureReports(page, [viewerContext]).catch(() => {});
      await attachPairingDiagnostics(test.info(), { camera: page, ...(observedViewer ? { viewer: observedViewer } : {}) }).catch(() => {});
      throw error;
    } finally { await viewerContext.close(); }
  });
});
