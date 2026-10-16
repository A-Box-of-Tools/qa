import fs from 'node:fs';
import path from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { ETOOLBOX_DIR } from './site';
import { withoutThirdParties } from './engine';

export const pairedTools = ['share-text', 'share-tab', 'walkie-talkie', 'voice-oncall', 'remote-camera'] as const;
export type PairedTool = typeof pairedTools[number];

export function usesSharedPairingUI(tool: PairedTool) {
  const file = path.join(ETOOLBOX_DIR, 'tools', tool, 'body.html');
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('partials/pairing-options.html');
}

export function pairingMarkup(tool: PairedTool) {
  const file = path.join(ETOOLBOX_DIR, 'tools', tool, 'body.html');
  if (!fs.existsSync(file)) return '';
  // Source gates must follow the same shared fragments the real build includes.
  return fs.readFileSync(file, 'utf8').replace(/{%\s*include\s+["']([^"']+)["']\s*%}/g, (include, relative) => {
    const fragment = path.join(ETOOLBOX_DIR, 'templates', relative);
    return fs.existsSync(fragment) ? fs.readFileSync(fragment, 'utf8') : include;
  });
}

export function hasOfflinePairing(tool: PairedTool) {
  const markup = pairingMarkup(tool);
  return usesSharedPairingUI(tool) && ['id="pairing-auto"', 'id="offline-offer-input"'].every(marker => markup.includes(marker));
}

/** Network hints choose the interface without blocking page assets. Every socket
 * construction is recorded before throwing, including swallowed discovery errors.
 * Native peers, descriptions, SCTP, codecs and media remain untouched. */
export async function offlineHooks(target: Page | BrowserContext, denyCapture = false, online = false) {
  await target.addInitScript(({ denyCapture, online }) => {
    const state = (window as any).__offlineQA = {
      online, sockets: 0, captures: 0, peers: [] as RTCPeerConnection[],
      localTypes: [] as string[], remoteTypes: [] as string[],
    };
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online });
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, { construct() {
      state.sockets++;
      throw new Error('Offline pairing attempted to contact a server.');
    } });
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeer, { construct(target, args) {
      const peer = Reflect.construct(target, args) as RTCPeerConnection;
      state.peers.push(peer);
      peer.addEventListener('icecandidate', event => {
        if (event.candidate) state.localTypes.push(event.candidate.type ?? 'unknown');
      });
      const remote = peer.setRemoteDescription.bind(peer);
      peer.setRemoteDescription = description => {
        state.remoteTypes.push(...[...(description?.sdp?.matchAll(/^a=candidate:[^\r\n]*\styp\s+(\w+)/gm) ?? [])].map(match => match[1]));
        return remote(description);
      };
      return peer;
    } });
    if (denyCapture) {
      const capture = async () => { state.captures++; throw new DOMException('Unexpected capture before consent', 'NotAllowedError'); };
      const media = navigator.mediaDevices;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media
        ? new Proxy(media, { get(target, property) {
          if (property === 'getUserMedia' || property === 'getDisplayMedia') return capture;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } }) : { getUserMedia: capture, getDisplayMedia: capture } });
    }
  }, { denyCapture, online });
}

export async function offlinePage(page: Page, tool: PairedTool) {
  await withoutThirdParties(page);
  await page.goto(`/${tool}/`);
  await expect(page.locator('#pairing-options')).toHaveAttribute('data-pairing-mode', 'offline');
  await expect(page.locator('#offline-offer-input')).toBeVisible();
  await expect(page.locator('[data-pairing-nearby]')).toBeHidden();
  await noOfflineServers(page);
}

export async function selectPairing(page: Page, method: 'auto' | 'online' | 'offline') {
  const options = page.locator('#pairing-options');
  if (!await options.evaluate((element: HTMLDetailsElement) => element.open)) await options.locator('summary').click();
  await page.locator(`#pairing-${method}`).check();
}

export async function networkHint(page: Page, online: boolean) {
  await page.evaluate(online => {
    (window as any).__offlineQA.online = online;
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  }, online);
}

export async function noOfflineServers(...pages: Page[]) {
  for (const page of pages) expect(await page.evaluate(() => (window as any).__offlineQA.sockets),
    'Offline must not attempt discovery, an introduction service or a relay.').toBe(0);
}

export async function offlineIdle(page: Page) {
  expect(await page.evaluate(() => {
    const state = (window as any).__offlineQA;
    return { sockets: state.sockets, captures: state.captures, peers: state.peers.length };
  })).toEqual({ sockets: 0, captures: 0, peers: 0 });
}

export function inspectOfflineBlock(text: string, tool: PairedTool, type: 'offer' | 'answer') {
  const block = JSON.parse(text);
  expect(Object.keys(block).sort()).toEqual(['description', 'expires', 'format', 'session', 'type']);
  expect(block).toMatchObject({ format: `${tool}-offline-v1`, type, session: expect.stringMatching(/^[a-f0-9]{32}$/),
    expires: expect.any(Number), description: { type, sdp: expect.stringMatching(/^v=0/) } });
  expect(block.description.sdp).toMatch(/^m=application\s/m);
  expect(block.description.sdp).not.toMatch(/^m=(?:audio|video)\s/m);
  const candidates = [...block.description.sdp.matchAll(/^a=candidate:[^\r\n]*\styp\s+(\w+)/gm)].map(match => match[1]);
  expect(candidates.length, 'The exported block contains gathered native candidates.').toBeGreaterThan(0);
  expect([...new Set(candidates)]).toEqual(['host']);
  return block;
}

export async function readOfflineOffer(host: Page, tool: PairedTool) {
  await expect(host.locator('#offline-offer')).not.toHaveValue('', { timeout: 25_000 });
  const offer = await host.locator('#offline-offer').inputValue();
  inspectOfflineBlock(offer, tool, 'offer');
  return offer;
}

export async function createOfflineReply(client: Page, tool: PairedTool, offer: string) {
  await client.locator('#offline-offer-input').fill(offer);
  await client.locator('#offline-reply').click();
  await expect(client.locator('#offline-answer')).not.toHaveValue('', { timeout: 25_000 });
  const answer = await client.locator('#offline-answer').inputValue();
  const reply = inspectOfflineBlock(answer, tool, 'answer');
  const invitation = inspectOfflineBlock(offer, tool, 'offer');
  expect([reply.session, reply.expires]).toEqual([invitation.session, invitation.expires]);
  await noOfflineServers(client);
  return answer;
}

export async function acceptOfflineReply(host: Page, answer: string) {
  await host.locator('#offline-answer-input').fill(answer);
  await host.locator('#offline-accept').click();
}

export async function freshOfflineOffer(host: Page, tool: PairedTool, previous: string) {
  await host.locator('#offline-new').click();
  await expect.poll(() => host.locator('#offline-offer').inputValue(), { timeout: 25_000 }).not.toBe(previous);
  const offer = await readOfflineOffer(host, tool);
  expect(JSON.parse(offer).session).not.toBe(JSON.parse(previous).session);
  return offer;
}

export async function nativeOfflineOnly(...pages: Page[]) {
  for (const page of pages) {
    const state = await page.evaluate(() => {
      const qa = (window as any).__offlineQA;
      const peers = qa.peers as RTCPeerConnection[];
      return { peers: peers.length, servers: peers.map(peer => peer.getConfiguration().iceServers ?? []),
        local: [...new Set<string>(qa.localTypes)], remote: [...new Set<string>(qa.remoteTypes)] };
    });
    expect(state.peers).toBeGreaterThan(0);
    expect(state.servers.every(servers => servers.length === 0)).toBe(true);
    expect(state.local).toEqual(['host']);
    expect(state.remote.every(type => type === 'host')).toBe(true);
  }
  await noOfflineServers(...pages);
}

export async function offlinePeersClosed(...pages: Page[]) {
  for (const page of pages) await expect.poll(() => page.evaluate(() => (window as any).__offlineQA.peers
    .every((peer: RTCPeerConnection) => peer.connectionState === 'closed')), { timeout: 15_000 }).toBe(true);
  await noOfflineServers(...pages);
}

/** Failure evidence omits descriptions, addresses, keys, names and content. */
export async function offlinePeerSnapshot(page: Page) {
  return page.evaluate(async () => {
    const qa = (window as any).__offlineQA;
    const peers = [];
    for (const peer of qa.peers as RTCPeerConnection[]) {
      const pairs: Record<string, unknown>[] = [], channels: Record<string, unknown>[] = [];
      try {
        const report = await peer.getStats();
        report.forEach(stat => {
          if (stat.type === 'candidate-pair') pairs.push(Object.fromEntries(['state', 'nominated', 'requestsSent',
            'responsesReceived', 'requestsReceived', 'responsesSent'].map(key => [key, stat[key]])));
          if (stat.type === 'data-channel') channels.push(Object.fromEntries(['state', 'messagesSent',
            'messagesReceived'].map(key => [key, stat[key]])));
        });
      } catch {}
      peers.push({ connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState,
        gathering: peer.iceGatheringState, sctp: peer.sctp?.state, dtls: peer.sctp?.transport.state, pairs, channels });
    }
    return { sockets: qa.sockets, localTypes: qa.localTypes, remoteTypes: qa.remoteTypes, peers };
  });
}

/** A failed application handshake remains failed. This bounded control checks
 * only whether the same native browser contexts can exchange host-only SCTP. */
export async function independentOfflineProbe(host: Page, reader: Page) {
  const initialize = async (page: Page, offer?: RTCSessionDescriptionInit) => page.evaluate(async offer => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    const state = (window as any).__offlineNativeProbe = { peer, received: false, channel: null as RTCDataChannel | null };
    const attach = (channel: RTCDataChannel) => {
      state.channel = channel;
      channel.onopen = () => { if (!offer) channel.send('ping'); };
      channel.onmessage = event => {
        if (event.data === 'ping') channel.send('pong');
        if (event.data === 'pong') state.received = true;
      };
    };
    peer.ondatachannel = event => attach(event.channel);
    if (offer) await peer.setRemoteDescription(offer);
    else attach(peer.createDataChannel('qa-offline-native-probe'));
    await peer.setLocalDescription(offer ? await peer.createAnswer() : await peer.createOffer());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native probe gathering timeout')), 5_000);
      const complete = () => {
        if (peer.iceGatheringState !== 'complete') return;
        clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', complete); resolve();
      };
      peer.addEventListener('icegatheringstatechange', complete); complete();
    });
    return peer.localDescription!.toJSON();
  }, offer);
  try {
    const offer = await initialize(host), answer = await initialize(reader, offer);
    await host.evaluate(answer => (window as any).__offlineNativeProbe.peer.setRemoteDescription(answer), answer);
    await host.evaluate(() => new Promise<void>(resolve => {
      const state = (window as any).__offlineNativeProbe;
      const timer = setTimeout(() => { clearInterval(poll); resolve(); }, 8_000);
      const poll = setInterval(() => { if (state.received) { clearInterval(poll); clearTimeout(timer); resolve(); } }, 100);
    }));
    return await host.evaluate(() => {
      const state = (window as any).__offlineNativeProbe;
      return { received: state.received, connection: state.peer.connectionState,
        ice: state.peer.iceConnectionState, channel: state.channel?.readyState };
    });
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'native probe failed' };
  } finally {
    for (const page of [host, reader]) await page.evaluate(() => {
      const state = (window as any).__offlineNativeProbe;
      state?.channel?.close(); state?.peer.close();
    }).catch(() => {});
  }
}
