import { test, expect } from '@playwright/test';
import { BASE_URL } from '../../lib/site';

// This diagnostic does not join the 42 relay acceptance cases or allocate TURN.
// Its exact opt-in matches the development workflow's existing title filter.
if (process.env.RUN_CLOUD_RELAY === '1' && process.env.CASE_FILTER === 'native video diagnostic') {
  test.use({ trace: 'off', video: 'off', screenshot: 'off' });
  test.describe.configure({ retries: 0 });

  test('native video diagnostic: visible canvas and direct RTC rendering', async ({ page }, info) => {
    test.setTimeout(35_000);
    const origin = new URL(BASE_URL);
    expect(origin.protocol === 'https:' && origin.hostname.endsWith('.abox-preview.pages.dev')).toBe(true);
    const address = new URL('/__qa-native-video-diagnostic', origin).href;
    await page.route(address, route => route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html><head><meta charset="utf-8"><title>Native video diagnostic</title></head>'
      + '<body><button id="start">Start native video diagnostic</button><div id="media"></div></body></html>' }));
    await page.goto(address);
    await page.evaluate(() => {
      const errors = new Set(['AbortError', 'InvalidAccessError', 'InvalidStateError', 'NotAllowedError',
        'NotSupportedError', 'OperationError', 'SecurityError', 'SyntaxError', 'TimeoutError', 'TypeError']);
      const errorName = (error: any) => errors.has(error?.name) ? error.name : 'UnknownError';
      const videos = new Map<string, { video: HTMLVideoElement; play: string; error: string | null;
        events: Record<string, number>; signatures: Set<number> }>();
      const peers: RTCPeerConnection[] = [], streams: MediaStream[] = [];
      const state = { stage: 'idle', error: null as string | null, paintedFrames: 0, streamAssociated: false };
      let timer: ReturnType<typeof setInterval> | undefined, stopped = false;
      const media = document.querySelector<HTMLElement>('#media')!;
      media.style.cssText = 'display:grid;grid-template-columns:repeat(2,320px);gap:8px';
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      media.append(canvas);
      const context = canvas.getContext('2d')!;
      const paint = () => {
        context.fillStyle = state.paintedFrames++ % 2 ? '#e02040' : '#2060e0';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#fff'; context.fillRect(state.paintedFrames % 260, 50, 60, 60);
      };
      const attach = (name: string, stream: MediaStream) => {
        const video = document.createElement('video');
        video.muted = true; video.autoplay = true; video.playsInline = true;
        video.width = 320; video.height = 180;
        media.append(video);
        const entry = { video, play: 'pending', error: null as string | null,
          events: {} as Record<string, number>, signatures: new Set<number>() };
        videos.set(name, entry);
        for (const type of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'error', 'stalled', 'emptied']) {
          video.addEventListener(type, () => { entry.events[type] = Math.min(100, (entry.events[type] ?? 0) + 1); });
        }
        video.srcObject = stream;
        void video.play().then(() => { entry.play = 'fulfilled'; }, error => {
          entry.play = 'rejected'; entry.error = errorName(error);
        });
      };
      const gathered = (peer: RTCPeerConnection) => new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') { resolve(); return; }
        const done = () => {
          if (peer.iceGatheringState !== 'complete') return;
          clearTimeout(deadline); peer.removeEventListener('icegatheringstatechange', done); resolve();
        };
        const deadline = setTimeout(() => {
          peer.removeEventListener('icegatheringstatechange', done);
          reject(new DOMException('Native gathering deadline', 'TimeoutError'));
        }, 4_000);
        peer.addEventListener('icegatheringstatechange', done);
      });
      const start = async () => {
        if (state.stage !== 'idle') return;
        state.stage = 'capture';
        try {
          paint();
          const source = canvas.captureStream(20); streams.push(source);
          timer = setInterval(paint, 50);
          attach('local', source);
          const sender = new RTCPeerConnection({ iceServers: [] });
          peers.push(sender);
          const receiver = new RTCPeerConnection({ iceServers: [] });
          peers.push(receiver);
          receiver.addEventListener('track', event => {
            if (stopped || event.track.kind !== 'video') return;
            state.streamAssociated = Boolean(event.streams[0]);
            const copied = new MediaStream([event.track]); streams.push(copied);
            attach('remote', copied);
          });
          source.getVideoTracks().forEach(track => sender.addTrack(track, source));
          state.stage = 'offer';
          await sender.setLocalDescription(await sender.createOffer());
          await gathered(sender);
          if (stopped) return;
          await receiver.setRemoteDescription(sender.localDescription!);
          state.stage = 'answer';
          await receiver.setLocalDescription(await receiver.createAnswer());
          await gathered(receiver);
          if (stopped) return;
          await sender.setRemoteDescription(receiver.localDescription!);
          if (!stopped) state.stage = 'negotiated';
        } catch (error) { state.error = errorName(error); state.stage = 'failed'; }
      };
      document.querySelector('#start')!.addEventListener('click', () => { void start(); });
      const sampleCanvas = document.createElement('canvas'); sampleCanvas.width = 16; sampleCanvas.height = 9;
      const sampleContext = sampleCanvas.getContext('2d')!;
      (window as any).__nativeVideoDiagnostic = {
        async snapshot() {
          const elements: Record<string, unknown> = {};
          for (const [name, entry] of videos) {
            const { video } = entry, stream = video.srcObject as MediaStream | null;
            if (!video.paused && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
              try {
                sampleContext.drawImage(video, 0, 0, 16, 9);
                let hash = 2166136261;
                for (const value of sampleContext.getImageData(0, 0, 16, 9).data) hash = Math.imul(hash ^ value, 16777619);
                if (entry.signatures.size < 3) entry.signatures.add(hash >>> 0);
              } catch { /* A failed paint remains a failed motion check. */ }
            }
            const box = video.getBoundingClientRect();
            elements[name] = { readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
              paused: video.paused, muted: video.muted, play: entry.play, playError: entry.error,
              errorCode: video.error?.code ?? null, visible: box.width > 0 && box.height > 0,
              inViewport: box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
              active: stream?.active ?? null, motion: entry.signatures.size > 1, events: { ...entry.events },
              tracks: stream?.getTracks().map(track => ({ kind: track.kind, state: track.readyState,
                enabled: track.enabled, muted: track.muted })) ?? [] };
          }
          const connections = [];
          for (const peer of peers) {
            let decodedFrames = 0, receivedBytes = 0;
            try {
              const report = await peer.getStats();
              report.forEach(row => {
                if (row.type === 'inbound-rtp' && row.kind === 'video') {
                  decodedFrames += row.framesDecoded ?? 0; receivedBytes += row.bytesReceived ?? 0;
                }
              });
            } catch { /* Final cleanup can race a diagnostic read. */ }
            connections.push({ connection: peer.connectionState, ice: peer.iceConnectionState,
              signaling: peer.signalingState, configuredServers: peer.getConfiguration().iceServers?.length ?? 0,
              decodedFrames, receivedBytes });
          }
          return { ...state, pageVisible: document.visibilityState === 'visible', elements, connections };
        },
        cleanup() {
          stopped = true; clearInterval(timer);
          for (const entry of videos.values()) { entry.video.pause(); entry.video.srcObject = null; }
          new Set(streams.flatMap(stream => stream.getTracks())).forEach(track => track.stop());
          peers.forEach(peer => peer.close());
        },
      };
    });
    let snapshot: any, failed = false;
    const read = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          page.evaluate(() => (window as any).__nativeVideoDiagnostic.snapshot()),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('snapshot-timeout')), 3_000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      await page.locator('#start').click();
      // Every sample is bounded externally; a wedged media promise cannot hide
      // an environment failure or turn it into a capability skip.
      const deadline = Date.now() + 15_000;
      do {
        snapshot = await read();
        if (snapshot.error || (snapshot.connections.length === 2
          && snapshot.connections.every((peer: any) => peer.connection === 'connected')
          && ['local', 'remote'].every(name => snapshot.elements[name]?.motion))) break;
        await page.waitForTimeout(250);
      } while (Date.now() < deadline);
      expect(snapshot.error, 'Native setup should complete without a site adapter or external server').toBeNull();
      expect(snapshot.connections).toHaveLength(2);
      expect(snapshot.connections.every((peer: any) => peer.connection === 'connected' && peer.configuredServers === 0)).toBe(true);
      for (const name of ['local', 'remote']) {
        expect(snapshot.elements[name]?.motion, name + ' must render changing visible video pixels').toBe(true);
      }
    } catch (error) {
      failed = true;
      if (error instanceof Error && error.message === 'snapshot-timeout') {
        snapshot = { ...snapshot, collectorError: 'snapshot-timeout' };
      }
      throw error;
    } finally {
      try {
        if (snapshot) {
          try {
            await info.attach('native-video-diagnostic', {
              body: JSON.stringify({ schema: 1, project: info.project.name, result: snapshot }, null, 2),
              contentType: 'application/json',
            });
          } catch (error) {
            if (!failed) throw error;
            info.annotations.push({ type: 'diagnostics', description: 'The native video diagnostic attachment could not be retained.' });
          }
        }
      } finally {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            page.evaluate(() => (window as any).__nativeVideoDiagnostic?.cleanup()).catch(() => {}),
            new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); }),
          ]);
        } finally { clearTimeout(timer); }
      }
    }
  });
}
