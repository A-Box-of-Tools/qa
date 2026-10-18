import type { BrowserContext, Page, TestInfo } from '@playwright/test';

/** Keep native objects in the page and export only an explicit safe summary.
 * Never serialize getStats(), a socket URL/frame, SDP or RTCConfiguration:
 * each can contain addresses, room capabilities or temporary TURN credentials. */
export async function observePairing(context: BrowserContext, tls443 = false) {
  await context.addInitScript(({ tls443 }) => {
    const qa = (window as any).__pairingQA = {
      peers: [] as RTCPeerConnection[], sockets: [] as WebSocket[],
      socketEvents: new Map<WebSocket, { closeCode: number | null; errors: number;
        sent: Record<string, number>; received: Record<string, number>; frameErrors: Record<string, number> }>(),
      iceErrors: new Map<RTCPeerConnection, Record<string, number>>(),
      constructorFailures: [] as Record<string, unknown>[], constructorFailuresDropped: 0,
      descriptions: [] as Record<string, unknown>[], descriptionsDropped: 0,
      relayRequests: 0, credentialReplies: 0, credentialErrors: 0,
      sentCandidateTypes: [] as string[], tlsOnly: tls443, tlsConfigurations: 0,
    };
    const frameTypes = new Set(['auth', 'host-ready', 'ready', 'join', 'leave', 'waiting', 'check',
      'offer', 'answer', 'candidate', 'signal', 'status', 'end', 'ended', 'replaced', 'moderated', 'kicked',
      'moderate', 'kick', 'error', 'relay-request', 'relay-credentials', 'publish', 'browse', 'shares']);
    const frameErrors = new Set(['invalid', 'stale', 'password', 'unauthorized', 'full', 'timeout',
      'transport-mismatch', 'relay-unavailable', 'unavailable', 'limited', 'forbidden', 'moderation-full']);
    const count = (values: Record<string, number>, key: string) => { values[key] = (values[key] ?? 0) + 1; };
    const describe = (frame: any, direction: 'sent' | 'received') => {
      const value = frame?.data ?? frame;
      if (!['offer', 'answer'].includes(value?.type) || typeof value.sdp !== 'string') return;
      if (qa.descriptions.length >= 12) { qa.descriptionsDropped++; return; }
      // These structural counts explain admission failures without keeping even
      // part of an SDP line, a sender identity, or an introduction capability.
      const lines = value.sdp.slice(0, 65_536).split(/\r?\n/).filter(Boolean);
      const media = { audio: 0, video: 0, application: 0, other: 0 };
      const directions = { sendonly: 0, recvonly: 0, sendrecv: 0, inactive: 0 };
      let audioProtocolMatches = 0;
      for (const line of lines) {
        if (line.startsWith('m=')) {
          const kind = line.match(/^m=(audio|video|application) /)?.[1] as keyof typeof media | undefined;
          media[kind ?? 'other']++;
          if (/^m=audio \d{1,5} (?:UDP|TCP)\/TLS\/RTP\/SAVPF [0-9 ]+$/.test(line)) audioProtocolMatches++;
        }
        const mode = line.match(/^a=(sendonly|recvonly|sendrecv|inactive)$/)?.[1] as keyof typeof directions | undefined;
        if (mode) directions[mode]++;
      }
      const uuid = (value: unknown) => typeof value === 'string'
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
      qa.descriptions.push({ direction, type: value.type, media, directions, audioProtocolMatches,
        lines: lines.length, bytes: value.sdp.length, versionFirst: lines[0] === 'v=0',
        invalidLines: lines.filter(line => !/^[a-z]=[\x20-\x7e]*$/.test(line)).length,
        generationUuid: uuid(value.generation), connectionUuid: uuid(value.connection),
        recipient: value.to === undefined ? 'absent' : uuid(value.to) ? 'uuid'
          : typeof value.to === 'string' && /^[a-f0-9]{64}$/.test(value.to) ? 'identity' : 'other' });
    };
    const NativePeer = window.RTCPeerConnection;
    if (NativePeer) window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, args) {
        const configuration = args[0] as RTCConfiguration | undefined;
        if (tls443 && configuration?.iceTransportPolicy === 'relay') {
          const iceServers = (configuration.iceServers ?? []).flatMap(server => {
            const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
              .filter(url => /^turns:[^?]+:443(?:\?transport=tcp)?$/i.test(url));
            return urls.length ? [{ ...server, urls }] : [];
          });
          if (!iceServers.length) throw new Error('QA requires a real TURN TLS/443 endpoint.');
          args = [{ ...configuration, iceServers }];
          qa.tlsConfigurations++;
        }
        let peer: RTCPeerConnection;
        try { peer = Reflect.construct(target, args) as RTCPeerConnection; }
        catch (error) {
          try {
          if (qa.constructorFailures.length >= 8) qa.constructorFailuresDropped++;
          else {
            const failure = error as Error;
            const names = ['TypeError', 'SyntaxError', 'InvalidAccessError', 'NotSupportedError', 'SecurityError', 'InvalidStateError', 'OperationError'];
            const reasons = ['Empty ICE servers list', 'STUN/TURN URL should be opaque-path',
              'Invalid TURN URL query string', 'ICE server protocol not supported', 'Invalid STUN URL'];
            const details: any = { name: names.includes(failure?.name) ? failure.name : 'other',
              reason: reasons.includes(failure?.message) ? failure.message : 'other',
              serverCount: 0, schemes: {}, ports: {}, transports: {}, fields: [] };
            const selected = args[0] as RTCConfiguration | undefined;
            const servers = Array.isArray(selected?.iceServers) ? selected.iceServers : [];
            details.serverCount = servers.length;
            const field = (value: unknown) => ({ type: value === null ? 'null' : typeof value,
              ...(typeof value === 'string' ? { length: value.length } : {}) });
            const count = (values: Record<string, number>, key: string) => { values[key] = (values[key] ?? 0) + 1; };
            for (const server of servers.slice(0, 12)) {
              const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
              details.fields.push({ urls: Array.isArray(server.urls) ? 'array' : typeof server.urls,
                urlCount: urls.length, username: field(server.username), credential: field(server.credential) });
              for (const url of urls.slice(0, 16)) {
                if (typeof url !== 'string') { count(details.schemes, 'other'); continue; }
                const scheme = url.match(/^([a-z]+):/i)?.[1]?.toLowerCase();
                count(details.schemes, scheme && ['turn', 'turns', 'stun', 'stuns'].includes(scheme) ? scheme : 'other');
                const port = url.match(/:(\d{1,5})(?:\?|$)/)?.[1];
                count(details.ports, port && Number(port) <= 65535 ? String(Number(port)) : 'unspecified');
                const query = new URLSearchParams(url.split('?')[1] ?? '');
                const transport = query.get('transport');
                count(details.transports, transport === null ? 'unspecified' : ['udp', 'tcp'].includes(transport) ? transport : 'other');
              }
            }
            qa.constructorFailures.push(details);
          }
          } catch {
            if (qa.constructorFailures.length < 8) qa.constructorFailures.push({ name: 'other', reason: 'other', diagnosticUnavailable: true });
          }
          throw error;
        }
        qa.peers.push(peer);
        const errors: Record<string, number> = {};
        qa.iceErrors.set(peer, errors);
        peer.addEventListener('icecandidateerror', event => {
          const code = (event as RTCPeerConnectionIceErrorEvent).errorCode;
          if (Number.isInteger(code) && code >= 0 && code <= 999) errors[code] = (errors[code] ?? 0) + 1;
        });
        return peer;
      },
    });
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        qa.sockets.push(socket);
        const events = { closeCode: null as number | null, errors: 0,
          sent: {} as Record<string, number>, received: {} as Record<string, number>, frameErrors: {} as Record<string, number> };
        qa.socketEvents.set(socket, events);
        socket.addEventListener('close', event => { events.closeCode = event.code; });
        socket.addEventListener('error', () => { events.errors++; });
        socket.addEventListener('message', event => {
          try {
            const frame = JSON.parse(String(event.data));
            count(events.received, frameTypes.has(frame?.type) ? frame.type : 'other');
            if (frame?.error !== undefined) count(events.frameErrors, frameErrors.has(frame.error) ? frame.error : 'other');
            describe(frame, 'received');
            if (frame.type === 'relay-credentials') {
              qa.credentialReplies++;
              if (frame.error) qa.credentialErrors++;
            }
          } catch { /* Keepalive frames are not JSON. */ }
        });
        const send = socket.send.bind(socket);
        socket.send = data => {
          if (typeof data === 'string') {
            try {
              const frame = JSON.parse(data);
              count(events.sent, frameTypes.has(frame?.type) ? frame.type : 'other');
              describe(frame, 'sent');
              if (frame.type === 'relay-request') qa.relayRequests++;
              const value = frame.data ?? frame;
              const candidate = value.candidate?.candidate;
              if (typeof candidate === 'string') {
                const type = candidate.match(/\btyp (host|srflx|prflx|relay)\b/)?.[1] ?? 'unknown';
                qa.sentCandidateTypes.push(type);
              }
            } catch { /* No payload is retained by this observer. */ }
          }
          send(data);
        };
        return socket;
      },
    });
  }, { tls443 });
}

export async function pairingSnapshot(page: Page): Promise<{
  observed: boolean; peers: any[]; relayRequests: number; credentialReplies: number; credentialErrors: number;
  candidateTypes: string[]; tlsOnly: boolean; tlsConfigurations: number; sockets: any[];
  capture: { calls: number; tracks: any[] } | null; browser?: { family: string; version: string; platform: string };
  constructorFailures?: Record<string, unknown>[]; constructorFailuresDropped?: number;
  descriptions?: Record<string, unknown>[]; descriptionsDropped?: number;
  video?: Record<string, unknown> | null;
}> {
  const result = await page.evaluate(async () => {
    const qa = (window as any).__pairingQA;
    if (!qa) return { observed: false, peers: [], relayRequests: 0, credentialReplies: 0, credentialErrors: 0,
      candidateTypes: [], tlsOnly: false, tlsConfigurations: 0, sockets: [], capture: null };
    const peers = [];
    for (const peer of qa.peers as RTCPeerConnection[]) {
      const configuration = peer.getConfiguration();
      const servers = configuration.iceServers ?? [];
      const tls443Only = servers.length > 0 && servers.every(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.length > 0 && urls.every(url => typeof url === 'string'
          && /^turns:[^?]+:443(?:\?transport=tcp)?$/i.test(url));
      });
      const entry: any = {
        connection: peer.connectionState, ice: peer.iceConnectionState,
        gathering: peer.iceGatheringState, signaling: peer.signalingState,
        policy: configuration.iceTransportPolicy ?? 'all', tls443Only,
        candidateErrors: { ...qa.iceErrors.get(peer) },
        selected: [], pairs: {}, checks: { requestsSent: 0, responsesReceived: 0, requestsReceived: 0, responsesSent: 0 },
        media: [], channels: [],
      };
      try {
        const stats = await peer.getStats();
        const selectedIds = new Set<string>();
        stats.forEach(stat => {
          if (stat.type === 'transport' && stat.selectedCandidatePairId) selectedIds.add(stat.selectedCandidatePairId);
        });
        stats.forEach(stat => {
          if (stat.type === 'candidate-pair') {
            entry.pairs[stat.state] = (entry.pairs[stat.state] ?? 0) + 1;
            for (const key of Object.keys(entry.checks)) entry.checks[key] += Number(stat[key]) || 0;
            if (selectedIds.has(stat.id) || (stat.nominated && stat.state === 'succeeded')) {
              const local = stats.get(stat.localCandidateId), remote = stats.get(stat.remoteCandidateId);
              entry.selected.push({
                local: local?.candidateType ?? 'unknown', remote: remote?.candidateType ?? 'unknown',
                protocol: local?.protocol ?? 'unknown', relayProtocol: local?.relayProtocol ?? 'unknown',
                bytesSent: stat.bytesSent ?? 0, bytesReceived: stat.bytesReceived ?? 0,
              });
            }
          } else if (stat.type === 'inbound-rtp' || stat.type === 'outbound-rtp') {
            const safe: Record<string, unknown> = {};
            for (const key of ['type', 'kind', 'packetsReceived', 'packetsSent', 'bytesReceived', 'bytesSent', 'framesDecoded', 'framesEncoded', 'totalAudioEnergy']) {
              if (key in stat) safe[key] = stat[key];
            }
            entry.media.push(safe);
          } else if (stat.type === 'data-channel') {
            entry.channels.push({ state: stat.state, messagesSent: stat.messagesSent, messagesReceived: stat.messagesReceived });
          }
        });
      } catch { entry.statsUnavailable = true; }
      const nativeProtocolAvailable = entry.selected.length > 0
        && entry.selected.every((pair: any) => pair.relayProtocol !== 'unknown');
      const constrainedRelay = tls443Only && entry.policy === 'relay' && entry.selected.length > 0
        && entry.selected.every((pair: any) => pair.local === 'relay' && pair.remote === 'relay'
          && pair.bytesSent > 0 && pair.bytesReceived > 0
          && ['tls', 'unknown'].includes(pair.relayProtocol));
      entry.tlsEvidence = { nativeProtocolAvailable, kind: !constrainedRelay ? 'unconfirmed'
        : nativeProtocolAvailable ? 'native-protocol-and-configuration' : 'configuration-and-relay-traffic' };
      peers.push(entry);
    }
    const capture = (window as any).__voiceQA ?? (window as any).__cameraQA;
    const browser = navigator.userAgent.match(/(Firefox|Chrome|Version)\/([\d.]+)/);
    return {
      observed: true, peers, browser: { family: browser?.[1] ?? 'unknown', version: browser?.[2] ?? 'unknown', platform: navigator.platform },
      relayRequests: qa.relayRequests, credentialReplies: qa.credentialReplies, credentialErrors: qa.credentialErrors,
      candidateTypes: [...new Set<string>(qa.sentCandidateTypes)].sort(),
      constructorFailures: qa.constructorFailures, constructorFailuresDropped: qa.constructorFailuresDropped,
      descriptions: qa.descriptions, descriptionsDropped: qa.descriptionsDropped,
      tlsOnly: qa.tlsOnly, tlsConfigurations: qa.tlsConfigurations,
      sockets: qa.sockets.map((socket: WebSocket) => ({ state: socket.readyState,
        discovery: new URL(socket.url).pathname === '/discover', ...qa.socketEvents.get(socket) })),
      capture: capture ? { calls: capture.calls.length, tracks: capture.tracks.map((track: MediaStreamTrack) =>
        ({ kind: track.kind, state: track.readyState, enabled: track.enabled, muted: track.muted })) } : null,
    };
  });
  return { ...result, video: await videoSnapshot(page) };
}

export async function videoSnapshot(page: Page, selector = '#remote-video') {
  return page.evaluate(selector => {
    const video = document.querySelector(selector) as HTMLVideoElement | null;
    if (!video) return null;
    const shown = (element: HTMLElement | null) => Boolean(element && !element.hidden && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
    const rectangle = video.getBoundingClientRect();
    return { paused: video.paused, readyState: video.readyState,
      width: video.videoWidth, height: video.videoHeight, muted: video.muted,
      autoplay: video.autoplay, playsInline: video.playsInline, visible: shown(video),
      pageVisible: document.visibilityState === 'visible',
      inViewport: rectangle.bottom > 0 && rectangle.right > 0 && rectangle.top < innerHeight && rectangle.left < innerWidth,
      playControlVisible: shown(document.getElementById('viewer-play')),
      errorCode: video.error?.code ?? null };
  }, selector);
}

export async function attachPairingDiagnostics(info: TestInfo, pages: Record<string, Page>, stage = 'failure') {
  const results: Record<string, unknown> = {};
  for (const [role, page] of Object.entries(pages)) {
    try { results[role] = page.isClosed() ? { closed: true } : await pairingSnapshot(page); }
    catch { results[role] = { unavailable: true }; }
  }
  await info.attach('address-free-pairing-diagnostics-' + stage, {
    body: JSON.stringify({ schema: 1, browserProject: info.project.name, results }, null, 2),
    contentType: 'application/json',
  });
}
