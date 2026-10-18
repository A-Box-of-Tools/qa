import { expect, test, type Page } from '@playwright/test';
import { videoSnapshot } from './pairing-diagnostics';

/** Firefox decoded hundreds of native relay frames while its media-element
 * quality counter remained zero. Inspect the video element's changing pixels
 * instead; this still fails for paused, frozen or unpainted media. */
export async function movingVideo(page: Page, selector = '#remote-video') {
  const video = page.locator(selector);
  let playbackFallbackUsed = false, playbackFallbackAttempted = false;
  const before = await videoSnapshot(page, selector);
  let playbackDeadline = Date.now() + 20_000;
  const sample = async () => {
    const play = page.locator('#viewer-play');
    if (!playbackFallbackAttempted && await play.isVisible()) {
      playbackFallbackAttempted = true;
      await play.click({ timeout: Math.max(1, playbackDeadline - Date.now()) });
      playbackFallbackUsed = true;
    }
    return video.evaluate((video: HTMLVideoElement) => {
      if (video.paused || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
      const context = canvas.getContext('2d')!;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let signature = 2166136261;
      for (const value of pixels) signature = Math.imul(signature ^ value, 16777619);
      return signature >>> 0;
    });
  };
  try {
    // Approval happens on the other page. Return to the viewer and use its
    // visible playback control, just as a person watching the stream would.
    await page.bringToFront();
    await video.scrollIntoViewIfNeeded({ timeout: Math.max(1, playbackDeadline - Date.now()) });
    await expect.poll(sample, { timeout: Math.max(1, playbackDeadline - Date.now()) }).not.toBeNull();
    const first = await sample();
    expect(first).not.toBeNull();
    playbackDeadline = Date.now() + 10_000;
    await expect.poll(async () => {
      const next = await sample();
      return next !== null && next !== first;
    }, { timeout: 10_000 }).toBe(true);
  } finally {
    try {
      await test.info().attach('address-free-video-playback', { contentType: 'application/json',
        body: JSON.stringify({ before, after: await videoSnapshot(page, selector), playbackFallbackUsed }) });
    } catch { test.info().annotations.push({ type: 'diagnostics', description: 'Video playback diagnostics could not be attached.' }); }
  }
}

type CameraMode = 'allow' | 'deny' | 'pending';

/** Native moving video exercises capture, encoding, decoding and track cleanup.
 * Only permission is supplied in live mode; deterministic cases can supply an introduction socket.
 * The live worker contract is checked separately against an admitted origin. */
export async function cameraHooks(page: Page, mode: CameraMode = 'allow', socketMode = 'open') {
  await page.addInitScript(({ mode, socketMode }) => {
    const state = (window as any).__cameraQA = { calls: [] as MediaStreamConstraints[], tracks: [] as MediaStreamTrack[], sockets: [] as any[], release: null as null | (() => void), holdNext: false };
    const devices = [{ kind: 'videoinput', deviceId: 'qa-camera-1', label: 'QA camera one' }, { kind: 'videoinput', deviceId: 'qa-camera-2', label: 'QA camera two' }];
    const makeStream = (deviceId: string, includeAudio: boolean, includeVideo: boolean) => {
      const stream = new MediaStream();
      if (includeVideo) {
        const canvas = document.createElement('canvas'); canvas.width = deviceId === 'qa-camera-2' ? 320 : 640; canvas.height = deviceId === 'qa-camera-2' ? 240 : 480;
        const ctx = canvas.getContext('2d')!; let frame = 0;
        const paint = () => { ctx.fillStyle = `hsl(${(frame++ * 37) % 360},70%,45%)`; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#fff'; ctx.fillRect(frame % 500, 150, 100, 100); };
        paint(); const timer = setInterval(paint, 50);
        canvas.captureStream(20).getVideoTracks().forEach((track) => {
          const settings = track.getSettings.bind(track); track.getSettings = () => ({ ...settings(), deviceId });
          stream.addTrack(track); state.tracks.push(track); const stop = track.stop.bind(track);
          track.stop = () => { stop(); clearInterval(timer); };
        });
      }
      if (includeAudio) {
        const audio = new AudioContext(), oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start();
        void audio.resume().catch(() => {});
        const track = destination.stream.getAudioTracks()[0], stop = track.stop.bind(track);
        state.tracks.push(track);
        track.stop = () => { if (track.readyState === 'ended') return; stop(); oscillator.stop(); void audio.close().catch(() => {}); };
        stream.addTrack(track);
      }
      return stream;
    };
    const getUserMedia = async (constraints: MediaStreamConstraints) => {
      state.calls.push(constraints);
      if (mode === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
      if (mode === 'pending' || state.holdNext) { state.holdNext = false; await new Promise<void>((resolve) => { state.release = resolve; }); }
      const video = constraints.video as MediaTrackConstraints;
      const deviceId = typeof video?.deviceId === 'object' ? String(video.deviceId.exact ?? 'qa-camera-1') : 'qa-camera-1';
      if (!devices.some((device) => device.deviceId === deviceId)) throw new DOMException('No such camera', 'OverconstrainedError');
      return makeStream(deviceId, Boolean(constraints.audio), Boolean(constraints.video));
    };
    // A WebKit init script can run before the native mediaDevices getter is
    // available. Bind the permission shim to navigator itself so navigation
    // cannot silently leave the real permission prompt in place.
    const media = navigator.mediaDevices;
    const supplied = media ? new Proxy(media, { get(target, property) {
      if (property === 'getUserMedia') return getUserMedia;
      if (property === 'enumerateDevices') return async () => devices;
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

