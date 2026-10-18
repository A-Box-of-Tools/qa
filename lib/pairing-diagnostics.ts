import type { BrowserContext, Page, TestInfo } from '@playwright/test';

/** Keep native objects in the page and export only an explicit safe summary.
 * Never serialize getStats(), a socket URL/frame, SDP or RTCConfiguration:
 * each can contain addresses, room capabilities or temporary TURN credentials. */
export async function observePairing(context: BrowserContext, tls443 = false) {
  await context.addInitScript(({ tls443 }) => {
    const qa = (window as any).__pairingQA = {
      peers: [] as RTCPeerConnection[], sockets: [] as WebSocket[],
      relayRequests: 0, credentialReplies: 0, credentialErrors: 0,
      sentCandidateTypes: [] as string[], tlsOnly: tls443, tlsConfigurations: 0,
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
        const peer = Reflect.construct(target, args) as RTCPeerConnection;
        qa.peers.push(peer);
        return peer;
      },
    });
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        qa.sockets.push(socket);
        socket.addEventListener('message', event => {
          try {
            const frame = JSON.parse(String(event.data));
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
}> {
  return page.evaluate(async () => {
    const qa = (window as any).__pairingQA;
    if (!qa) return { observed: false, peers: [], relayRequests: 0, credentialReplies: 0, credentialErrors: 0,
      candidateTypes: [], tlsOnly: false, tlsConfigurations: 0, sockets: [], capture: null };
    const peers = [];
    for (const peer of qa.peers as RTCPeerConnection[]) {
      const entry: any = {
        connection: peer.connectionState, ice: peer.iceConnectionState,
        gathering: peer.iceGatheringState, signaling: peer.signalingState,
        policy: peer.getConfiguration().iceTransportPolicy ?? 'all',
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
      peers.push(entry);
    }
    const capture = (window as any).__voiceQA ?? (window as any).__cameraQA;
    const browser = navigator.userAgent.match(/(Firefox|Chrome|Version)\/([\d.]+)/);
    return {
      observed: true, peers, browser: { family: browser?.[1] ?? 'unknown', version: browser?.[2] ?? 'unknown', platform: navigator.platform },
      relayRequests: qa.relayRequests, credentialReplies: qa.credentialReplies, credentialErrors: qa.credentialErrors,
      candidateTypes: [...new Set<string>(qa.sentCandidateTypes)].sort(),
      tlsOnly: qa.tlsOnly, tlsConfigurations: qa.tlsConfigurations,
      sockets: qa.sockets.map((socket: WebSocket) => ({ state: socket.readyState, discovery: new URL(socket.url).pathname === '/discover' })),
      capture: capture ? { calls: capture.calls.length, tracks: capture.tracks.map((track: MediaStreamTrack) =>
        ({ kind: track.kind, state: track.readyState, enabled: track.enabled, muted: track.muted })) } : null,
    };
  });
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
