import { expect, type BrowserContext, type Page } from '@playwright/test';
import { withoutThirdParties } from './engine';
import { liveRendezvous } from './rendezvous';

export const SHARE_TAB = '/share-tab/';
export type CaptureMode = 'allow' | 'denied' | 'cancelled' | 'pending' | 'window' | 'monitor' | 'unknown';

/** Only the picker result is supplied. Tracks, codecs, RTP, SCTP and peers stay native. */
export async function tabHooks(context: BrowserContext, options: {
  capture?: CaptureMode; holdAck?: boolean; deferLocalOpen?: boolean; live?: boolean;
} = {}) {
  await context.addInitScript(({ capture, holdAck, deferLocalOpen, live }) => {
    const state = (window as any).__tabQA = {
      captures: [] as any[], userMedia: 0, tracks: [] as MediaStreamTrack[],
      peers: [] as RTCPeerConnection[], channels: [] as RTCDataChannel[], received: [] as MediaStreamTrack[],
      sockets: [] as any[], controls: [] as { type: string; peer: number }[],
      signals: [] as { type: string; media: string[]; relay: boolean; noteLeaked: boolean }[],
      releaseCapture: null as null | (() => void), releaseAck: null as null | (() => void),
      ackHeld: false, delayedOpenReplayed: 0, fixtureErrors: [] as string[],
      note: '',
    };
    const makeStream = () => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d')!; let frame = 0;
      const paint = () => {
        ctx.fillStyle = `hsl(${(frame++ * 41) % 360},75%,35%)`; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff'; ctx.fillRect((frame * 13) % 560, 130, 80, 80);
      };
      paint(); const timer = setInterval(paint, 50);
      const stream = canvas.captureStream(20), track = stream.getVideoTracks()[0];
      const settings = track.getSettings.bind(track), stop = track.stop.bind(track);
      track.getSettings = () => ({ ...settings(), ...(capture === 'unknown' ? {} : {
        displaySurface: capture === 'window' || capture === 'monitor' ? capture : 'browser',
      }) });
      track.stop = () => { stop(); clearInterval(timer); };
      state.tracks.push(track);
      return stream;
    };
    const getDisplayMedia = async (constraints: any) => {
      state.captures.push(constraints);
      if (capture === 'denied') throw new DOMException('QA refused picker', 'NotAllowedError');
      if (capture === 'cancelled') throw new DOMException('QA cancelled picker', 'AbortError');
      if (capture === 'pending') await new Promise<void>((resolve) => { state.releaseCapture = resolve; });
      return makeStream();
    };
    const media = navigator.mediaDevices;
    const supplied = media ? new Proxy(media, { get(target, property) {
      if (property === 'getDisplayMedia') return getDisplayMedia;
      if (property === 'getUserMedia') return async () => { state.userMedia++; throw new Error('Viewer must not capture camera or microphone'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) : { getDisplayMedia, getUserMedia: async () => { state.userMedia++; throw new Error('Unexpected user media'); } };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: supplied });

    const observeChannel = (channel: RTCDataChannel, peer: number, incoming: boolean) => {
      state.channels.push(channel);
      const send = channel.send.bind(channel);
      Object.defineProperty(channel, 'send', { configurable: true, value(data: any) {
        let type = '';
        try { type = JSON.parse(data).type ?? ''; } catch { /* Binary/invalid input is not an app command. */ }
        state.controls.push({ type, peer });
        if (holdAck && type === 'approval-ack' && !state.releaseAck) {
          state.ackHeld = true;
          state.releaseAck = () => { state.ackHeld = false; send(data); };
          return;
        }
        return send(data);
      } });
      if (deferLocalOpen && incoming) {
        // Reorder only app notifications: the native channel is already open
        // when its first message arrives, while its local open callback waits.
        const add = channel.addEventListener.bind(channel);
        const getReady = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'readyState')!.get!;
        let bootstrap = true, replayed = false;
        const opens: { listener: EventListenerOrEventListenerObject; options?: any }[] = [];
        Object.defineProperty(channel, 'readyState', { configurable: true, get: () => bootstrap ? 'connecting' : getReady.call(channel) });
        queueMicrotask(() => { bootstrap = false; });
        Object.defineProperty(channel, 'addEventListener', { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: any) {
          if (type === 'open') { opens.push({ listener, options }); return; }
          if (type !== 'message') return add(type, listener, options);
          return add(type, (event: Event) => {
            if (typeof listener === 'function') listener.call(channel, event); else listener.handleEvent(event);
            if (!replayed) {
              replayed = true; state.delayedOpenReplayed++;
              for (const item of opens) {
                const opened = new Event('open');
                if (typeof item.listener === 'function') item.listener.call(channel, opened); else item.listener.handleEvent(opened);
              }
            }
          }, options);
        } });
      }
    };
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args) {
      const peer = Reflect.construct(target, args) as RTCPeerConnection, index = state.peers.length;
      state.peers.push(peer);
      peer.addEventListener('track', (event) => state.received.push(event.track));
      peer.addEventListener('datachannel', (event) => observeChannel(event.channel, index, true));
      const create = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (...values) => { const channel = create(...values); observeChannel(channel, index, false); return channel; };
      return peer;
    } });
    if (live) {
      const NativeSocket = window.WebSocket;
      window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        state.sockets.push(socket);
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          if (typeof data === 'string' && data !== 'ping') {
            const envelope = JSON.parse(data), description = envelope.data?.description;
            state.signals.push({ type: description?.type ?? (envelope.relay ? 'relay' : 'signal'),
              media: description?.sdp?.match(/^m=\w+/gm)?.map((value: string) => value.slice(2)) ?? [],
              relay: envelope.relay === true, noteLeaked: Boolean(state.note && data.includes(state.note)) });
          }
          return send(data);
        };
        return socket;
      } });
    }
  }, { capture: options.capture ?? 'allow', holdAck: options.holdAck ?? false,
    deferLocalOpen: options.deferLocalOpen ?? false, live: options.live ?? false });
}

/** Opaque room routing only; this stand-in never creates SDP, peers or media. */
export function tabBroker({ holdDescriptions = false, relay = 'unavailable', privateNotes = [] }: {
  holdDescriptions?: boolean; relay?: 'unavailable' | 'configured'; privateNotes?: string[];
} = {}) {
  const endpoint = liveRendezvous('tools/share-tab/src/session.js');
  type Client = { page: Page; socket: number; code: string; role: string; id: string; ready: boolean };
  type Room = { host?: Client; viewers: Map<string, Client>; queue: Promise<void> };
  const rooms = new Map<string, Room>(), clients = new Map<Page, Map<number, Client>>(); let serial = 0;
  const observed = { urls: [] as string[], relayRequests: 0, descriptions: [] as { type: string; media: string[] }[], noteLeaked: false };
  const roomFor = (code: string) => { if (!rooms.has(code)) rooms.set(code, { viewers: new Map(), queue: Promise.resolve() }); return rooms.get(code)!; };
  const message = async (client: Client, data: unknown) => {
    if (!client.page.isClosed()) await client.page.evaluate(({ socket, data }) => (window as any).__tabQA.sockets[socket]?.receive(data), { socket: client.socket, data });
  };
  const close = async (client: Client, code: number) => {
    if (!client.page.isClosed()) await client.page.evaluate(({ socket, code }) => (window as any).__tabQA.sockets[socket]?.remoteClose(code), { socket: client.socket, code });
  };
  const enqueue = (room: Room, work: () => Promise<void>) => { const next = room.queue.then(work); room.queue = next.catch(() => {}); return next; };
  const drop = (client: Client) => {
    clients.get(client.page)?.delete(client.socket);
    const room = roomFor(client.code);
    return enqueue(room, async () => {
      if (client.role === 'host' && room.host === client) {
        room.host = undefined; const viewers = [...room.viewers.values()]; room.viewers.clear();
        for (const viewer of viewers) await close(viewer, 4410);
      } else if (client.role === 'viewer' && room.viewers.get(client.id) === client) {
        room.viewers.delete(client.id); if (room.host) await message(room.host, { type: 'leave', id: client.id });
      }
    });
  };
  const install = async (context: BrowserContext) => {
    await context.exposeBinding('__tabBrokerOpen', ({ page }, socket: number, address: string) => {
      const url = new URL(address), code = url.pathname.split('/').pop()!, role = url.searchParams.get('role')!;
      if (url.origin !== endpoint || !/^\/ws\/tab-[a-z2-7]{16}$/.test(url.pathname)
          || url.searchParams.get('tool') !== 'share-tab' || !['host', 'viewer'].includes(role)) throw new Error('Unexpected Share Tab room contract');
      observed.urls.push(address);
      const client: Client = { page, socket, code, role, id: `v:${++serial}`, ready: false }, room = roomFor(code);
      if (!clients.has(page)) {
        clients.set(page, new Map());
        page.on('close', () => { for (const item of clients.get(page)?.values() ?? []) void drop(item).catch(() => {}); clients.delete(page); });
      }
      clients.get(page)!.set(socket, client);
      if (role === 'host') room.host = client; else room.viewers.set(client.id, client);
    });
    await context.exposeBinding('__tabBrokerReady', ({ page }, socket: number) => {
      const client = clients.get(page)?.get(socket); if (!client) return;
      client.ready = true; const room = roomFor(client.code);
      return enqueue(room, async () => {
        if (!room.host?.ready) return;
        if (client.role === 'viewer') await message(client, { type: 'ready' });
        else for (const viewer of room.viewers.values()) if (viewer.ready) await message(viewer, { type: 'ready' });
      });
    });
    await context.exposeBinding('__tabBrokerSend', ({ page }, socket: number, raw: string) => {
      const client = clients.get(page)?.get(socket); if (!client) return;
      const room = roomFor(client.code);
      return enqueue(room, async () => {
        if (raw === 'ping') { await message(client, 'pong'); return; }
        const envelope = JSON.parse(raw);
        if (envelope.relay === true) {
          observed.relayRequests++;
          await message(client, { type: 'relay', iceServers: relay === 'configured' ? [{
            urls: ['turn:127.0.0.1:9?transport=udp'], username: 'qa-supplied-not-a-service', credential: 'qa-supplied-not-a-service',
          }] : [] });
          return;
        }
        const description = envelope.data?.description;
        if (description) observed.descriptions.push({ type: description.type,
          media: description.sdp.match(/^m=\w+/gm)?.map((value: string) => value.slice(2)) ?? [] });
        if ('note' in (envelope.data ?? {}) || privateNotes.some((note) => raw.includes(note))) observed.noteLeaked = true;
        if (holdDescriptions && description) return;
        if (client.role === 'host') {
          const viewer = room.viewers.get(envelope.to); if (viewer) await message(viewer, { type: 'signal', data: envelope.data });
        } else if (room.host) await message(room.host, { type: 'signal', from: client.id, data: envelope.data });
      });
    });
    await context.exposeBinding('__tabBrokerClose', ({ page }, socket: number) => {
      const client = clients.get(page)?.get(socket); if (client) return drop(client);
    });
    await context.addInitScript(() => {
      class BrokerSocket extends EventTarget {
        readyState = 0; url: string; id: number;
        constructor(address: string | URL) {
          super(); const state = (window as any).__tabQA;
          this.id = state.sockets.length; this.url = String(address); state.sockets.push(this);
          queueMicrotask(async () => {
            try {
              await (window as any).__tabBrokerOpen(this.id, this.url);
              if (this.readyState !== 0) return;
              this.readyState = 1; this.emit(new Event('open')); await (window as any).__tabBrokerReady(this.id);
            } catch (error) { state.fixtureErrors.push(String(error)); this.remoteClose(1008); }
          });
        }
        emit(event: Event) { this.dispatchEvent(event); (this as any)[`on${event.type}`]?.(event); }
        send(data: string) {
          if (this.readyState !== 1) throw new Error('Socket closed');
          const state = (window as any).__tabQA;
          void (window as any).__tabBrokerSend(this.id, data).catch((error: unknown) => state.fixtureErrors.push(String(error)));
        }
        receive(data: unknown) { if (this.readyState === 1) this.emit(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) })); }
        remoteClose(code: number) { if (this.readyState === 3) return; this.readyState = 3; this.emit(new CloseEvent('close', { code })); }
        close(code = 1000) { if (this.readyState === 3) return; this.remoteClose(code); void (window as any).__tabBrokerClose(this.id).catch(() => {}); }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: BrokerSocket });
    });
  };
  return { install, observed };
}

export async function prepareTabPage(page: Page, code?: string) {
  await withoutThirdParties(page);
  await page.goto(code ? `${SHARE_TAB}#${code}` : SHARE_TAB);
  await expect(page.locator('#viewer-connect')).toBeVisible();
  await expect(page.locator('#boot-warning')).toHaveCount(0);
}

export async function startTabHost(page: Page) {
  await prepareTabPage(page);
  await page.locator('#host-start').click();
  await expect(page.locator('#share-link')).toHaveValue(/#tab-[a-z2-7]{16}$/, { timeout: 20_000 });
  const invitation = await page.locator('#share-link').inputValue();
  return { invitation, code: new URL(invitation).hash.slice(1) };
}

export async function requestTab(page: Page, code: string, note: string) {
  await prepareTabPage(page, code);
  await page.evaluate((note) => { (window as any).__tabQA.note = note; }, note);
  await page.locator('#viewer-name').fill(note);
  await page.locator('#viewer-connect').click();
}

export function requestRow(host: Page, note: string) { return host.locator('#viewer-requests li').filter({ hasText: note }); }

export async function noTabMedia(host: Page, viewer: Page) {
  expect(await host.evaluate(() => (window as any).__tabQA.peers.every((peer: RTCPeerConnection) => peer.getSenders().every((sender) => !sender.track)))).toBe(true);
  expect(await viewer.evaluate(() => ({ tracks: (window as any).__tabQA.received.length,
    capture: (window as any).__tabQA.captures.length, userMedia: (window as any).__tabQA.userMedia }))).toEqual({ tracks: 0, capture: 0, userMedia: 0 });
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
}

export async function flowingTab(viewer: Page) {
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => [video.videoWidth, video.videoHeight]), { timeout: 20_000 }).toEqual([640, 360]);
  const first = await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => video.getVideoPlaybackQuality().totalVideoFrames), { timeout: 10_000 }).toBeGreaterThan(first + 2);
  expect(await viewer.locator('#remote-video').evaluate((video: HTMLVideoElement) => (video.srcObject as MediaStream).getTracks().map((track) => track.kind))).toEqual(['video']);
  await expect.poll(() => viewer.evaluate(async () => {
    const peer = (window as any).__tabQA.peers.at(-1) as RTCPeerConnection;
    const inbound = [...(await peer.getStats()).values()].find((item) => item.type === 'inbound-rtp' && item.kind === 'video');
    return peer.connectionState === 'connected' && inbound?.framesDecoded > 2 && inbound?.bytesReceived > 0;
  })).toBe(true);
}

export async function stoppedTab(page: Page, host = false) {
  await expect.poll(() => page.evaluate(() => (window as any).__tabQA.peers.every((peer: RTCPeerConnection) => peer.connectionState === 'closed'))).toBe(true);
  await expect.poll(() => page.locator(host ? '#local-video' : '#remote-video').evaluate((video: HTMLVideoElement) => video.srcObject === null)).toBe(true);
  if (host) {
    await expect.poll(() => page.evaluate(() => (window as any).__tabQA.tracks.length > 0
      && (window as any).__tabQA.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'))).toBe(true);
    await expect(page.locator('#share-link')).toHaveValue('');
  }
}
