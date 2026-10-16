import { expect, type Page } from '@playwright/test';
import { BASE_URL } from './site';
import { liveRendezvous } from './rendezvous';

export function admitsLiveVoice(): boolean {
  const url = new URL(BASE_URL);
  return url.origin === 'https://abox.tools' || ['localhost', '127.0.0.1'].includes(url.hostname)
    || (url.protocol === 'https:' && url.hostname.endsWith('.abox-preview.pages.dev'));
}

export function liveVoiceEndpoint(): string {
  return liveRendezvous('shared/js/voice-session.js');
}

/** Supply an oscillator instead of asking for a person's microphone. Peers,
 * codecs, received streams and the live signaling service remain native. */
export async function voiceHooks(page: Page, capture: 'allow' | 'deny', quietDiscovery = false,
  discoveryList: { code: string; name: string; locked?: boolean; listenKey?: string }[] = []) {
  await page.addInitScript(({ capture, quietDiscovery, discoveryList }) => {
    const state = (window as any).__voiceQA = {
      calls: [] as MediaStreamConstraints[], tracks: [] as MediaStreamTrack[],
      peers: [] as RTCPeerConnection[], gains: [] as GainNode[], analysers: [] as AnalyserNode[],
      contexts: [] as AudioContext[], captureContexts: [] as AudioContext[], sockets: [] as WebSocket[],
    };
    const NativeAudio = window.AudioContext || (window as any).webkitAudioContext;
    if (NativeAudio) {
      const ObservedAudio = new Proxy(NativeAudio, {
        construct(target, args) {
          const context = Reflect.construct(target, args) as AudioContext;
          state.contexts.push(context);
          const createGain = context.createGain.bind(context);
          context.createGain = () => {
            const gain = createGain(); state.gains.push(gain);
            // Observe the app's existing output without adding an audible route.
            const analyser = context.createAnalyser();
            gain.connect(analyser); state.analysers.push(analyser);
            return gain;
          };
          return context;
        },
      });
      if (window.AudioContext) window.AudioContext = ObservedAudio;
      else (window as any).webkitAudioContext = ObservedAudio;
    }
    const getUserMedia = async (constraints: MediaStreamConstraints) => {
      state.calls.push(constraints);
      if (capture === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      const context: AudioContext = new NativeAudio();
      state.captureContexts.push(context);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.15;
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      for (const track of destination.stream.getTracks()) {
        state.tracks.push(track);
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          try { oscillator.stop(); } catch {}
          void context.close().catch(() => {});
        };
      }
      await context.resume();
      return destination.stream;
    };
    // Bind navigator itself: WebKit can expose mediaDevices after init scripts.
    const media = navigator.mediaDevices;
    const supplied = media ? new Proxy(media, { get(target, property) {
      if (property === 'getUserMedia') return getUserMedia;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) : { getUserMedia };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: supplied });

    const NativePeer = window.RTCPeerConnection;
    if (NativePeer) window.RTCPeerConnection = new Proxy(NativePeer, {
      construct(target, args) {
        const peer = Reflect.construct(target, args) as RTCPeerConnection;
        state.peers.push(peer);
        return peer;
      },
    });
    const NativeSocket = window.WebSocket;
    class EmptyDiscovery extends EventTarget {
      readyState = 0;
      bufferedAmount = 0;
      constructor(public url: string) {
        super();
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.emit(new Event('open'));
          const tool = new URL(this.url).searchParams.get('tool');
          this.emit(new MessageEvent('message', { data: JSON.stringify({ type: 'shares',
            ...(tool && tool !== 'share-text' ? { tool } : {}), list: discoveryList }) }));
        });
      }
      emit(event: Event) { this.dispatchEvent(event); (this as any)[`on${event.type}`]?.(event); }
      send(data: string) {
        if (data === 'ping') queueMicrotask(() => this.emit(new MessageEvent('message', { data: 'pong' })));
      }
      close() { this.readyState = 3; this.emit(new CloseEvent('close', { code: 1000 })); }
    }
    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args) {
        // Refusal tests must not depend on an unrelated discovery connection.
        const socket = quietDiscovery && new URL(String(args[0])).pathname === '/discover'
          ? new EmptyDiscovery(String(args[0])) : Reflect.construct(target, args);
        state.sockets.push(socket);
        return socket;
      },
    });
  }, { capture, quietDiscovery, discoveryList });
}

export async function receivedAudio(page: Page): Promise<{ packets: number; energy: number }> {
  return page.evaluate(async () => {
    let packets = 0, energy = 0;
    for (const peer of (window as any).__voiceQA.peers as RTCPeerConnection[]) {
      if (peer.connectionState !== 'connected') continue;
      const report = await peer.getStats();
      report.forEach(stat => {
        if (stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio')) {
          packets += stat.packetsReceived || 0;
          energy += stat.totalAudioEnergy || 0;
        }
      });
    }
    return { packets, energy };
  });
}

export async function tracksStopped(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const tracks: MediaStreamTrack[] = (window as any).__voiceQA.tracks;
    return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
  })).toBe(true);
}

export async function peersClosed(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const peers: RTCPeerConnection[] = (window as any).__voiceQA.peers;
    return peers.length > 0 && peers.every(peer => peer.connectionState === 'closed');
  })).toBe(true);
}

export async function microphoneEnabled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const live = ((window as any).__voiceQA.tracks as MediaStreamTrack[]).filter(track => track.readyState === 'live');
    return live.length > 0 && live.every(track => track.enabled);
  });
}

/** Exercise the page's lifecycle contract without claiming to reproduce an OS
 * screen lock. Capture, RTP senders, peers and signaling remain native. */
export async function installVoiceLifecycle(page: Page) {
  await page.evaluate(() => {
    let hidden = false;
    const lifecycle = {
      attempts: 0, denyNextCapture: false,
      setHidden(value: boolean) {
        hidden = value;
        document.dispatchEvent(new Event('visibilitychange'));
      },
      interrupt(kind: 'mute' | 'unmute' | 'ended') {
        const track = ((window as any).__voiceQA.tracks as MediaStreamTrack[]).find(track => track.readyState === 'live');
        if (!track) throw new Error('No live synthetic capture track.');
        if (kind === 'ended') {
          // stop() does not dispatch ended; an external device loss does both.
          track.stop();
        } else {
          // A synthetic event alone does not change the native readonly flag.
          Object.defineProperty(track, 'muted', { configurable: true, value: kind === 'mute' });
        }
        track.dispatchEvent(new Event(kind));
      },
    };
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const media = navigator.mediaDevices;
    const capture = media.getUserMedia.bind(media);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: new Proxy(media, {
        get(target, property) {
          if (property === 'getUserMedia') return async (constraints: MediaStreamConstraints) => {
            lifecycle.attempts++;
            if (lifecycle.denyNextCapture) {
              lifecycle.denyNextCapture = false;
              throw new DOMException('Permission denied during recovery', 'NotAllowedError');
            }
            return capture(constraints);
          };
          return Reflect.get(target, property, target);
        },
      }),
    });
    (window as any).__voiceLifecycle = lifecycle;
  });
}

export async function voiceConnectionState(page: Page, route: 'broadcast' | 'inbox') {
  return page.evaluate(route => {
    const qa = (window as any).__voiceQA;
    const peers: RTCPeerConnection[] = qa.peers;
    const rooms = (qa.sockets as WebSocket[]).filter(socket => new URL(socket.url).pathname.startsWith(`/${route}/`));
    return { peers: peers.length, connected: peers.filter(peer => peer.connectionState === 'connected').length,
      rooms: rooms.length, open: rooms.filter(socket => socket.readyState === WebSocket.OPEN).length };
  }, route);
}

export async function captureAttached(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const qa = (window as any).__voiceQA;
    const tracks = (qa.tracks as MediaStreamTrack[]).filter(track => track.readyState === 'live');
    const peers = (qa.peers as RTCPeerConnection[]).filter(peer => peer.connectionState === 'connected');
    return tracks.length === 1 && peers.length > 0 && peers.every(peer =>
      peer.getSenders().some(sender => sender.track === tracks[0]));
  });
}

/** Chromium's inbound RTP energy follows the native media element, which can
 * stay muted while the app plays the same stream through Web Audio. Sample
 * the app's output after its own gain so this also verifies local muting. */
export async function outputRms(page: Page): Promise<number> {
  return page.evaluate(() => {
    const analysers: AnalyserNode[] = (window as any).__voiceQA.analysers;
    return Math.max(0, ...analysers.map(analyser => {
      if (analyser.context.state !== 'running') return 0;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
    }));
  });
}

export async function voiceSnapshot(page: Page) {
  return page.evaluate(async () => {
    const qa = (window as any).__voiceQA;
    const tracks = (track: MediaStreamTrack | null) => track && ({ kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState });
    const peers = [];
    for (const peer of qa.peers as RTCPeerConnection[]) {
      const stats: Record<string, unknown>[] = [];
      (await peer.getStats()).forEach(stat => {
        if (!['media-source', 'inbound-rtp', 'outbound-rtp'].includes(stat.type)) return;
        const selected: Record<string, unknown> = {};
        for (const key of ['type', 'kind', 'mediaType', 'packetsReceived', 'packetsSent', 'bytesReceived', 'bytesSent', 'totalAudioEnergy', 'totalSamplesDuration', 'audioLevel']) {
          if (key in stat) selected[key] = stat[key];
        }
        stats.push(selected);
      });
      peers.push({ state: peer.connectionState, signaling: peer.signalingState,
        transceivers: peer.getTransceivers().map(t => ({ direction: t.direction, currentDirection: t.currentDirection, sender: tracks(t.sender.track), receiver: tracks(t.receiver.track) })), stats });
    }
    return { contexts: qa.contexts.map((context: AudioContext) => ({ state: context.state, time: context.currentTime })),
      captureContexts: qa.captureContexts.map((context: AudioContext) => context.state),
      gains: qa.gains.map((gain: GainNode) => gain.gain.value),
      rms: qa.analysers.map((analyser: AnalyserNode) => {
        const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
        return Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
      }), tracks: qa.tracks.map(tracks), peers,
      audio: Array.from(document.querySelectorAll('audio')).map(audio => ({ paused: audio.paused, muted: audio.muted, volume: audio.volume, readyState: audio.readyState, hasStream: Boolean(audio.srcObject) })) };
  });
}
