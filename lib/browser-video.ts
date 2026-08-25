import type { Page } from '@playwright/test';

export interface VideoFixtureOptions {
  width?: number;
  height?: number;
  seconds?: number;
  fps?: number;
  /**
   * Ask for WebM rather than MP4.
   *
   * The video tools read MP4 and MOV themselves and fall back to a slower
   * path - seek to each frame, draw it, re-encode - for anything else the
   * browser will merely play. A WebM is the way to reach that fallback on a
   * browser whose MP4 support is fine, and the fallback is worth reaching:
   * it is where the frame rate is guessed and where `duration` decides how
   * many frames get written.
   */
  prefer?: 'mp4' | 'webm';
}

/**
 * A real video, recorded by the browser under test from a canvas animation.
 *
 * Encoding H.264 in Node would mean vendoring an encoder; the browser already
 * has one, and etoolbox's own JavaScript tests build their fixtures the same
 * way (see the fixture notes in tools/trim-video/README.md). MediaRecorder in
 * this Chromium reports support for video/mp4;codecs=avc1, which is the
 * container the video tools take their fast path on - it falls back to WebM
 * only if that ever stops being true, and returns which it produced so a test
 * can say so rather than guess.
 *
 * The picture is a colour that changes over time with a bar sweeping across
 * it, so a frame grabbed at two seconds is visibly not the frame at zero and a
 * trimmed section can be told from the part that was cut.
 *
 * Duration is wall-clock, so it lands near the number asked for rather than on
 * it. Tests assert with a tolerance, which is the honest way to treat it.
 */
export async function recordVideo(
  page: Page,
  options: VideoFixtureOptions = {},
): Promise<{ bytes: Buffer; mimeType: string }> {
  const settings = {
    width: options.width ?? 320,
    height: options.height ?? 240,
    seconds: options.seconds ?? 3,
    fps: options.fps ?? 20,
    prefer: options.prefer ?? 'mp4',
  };

  const result = await page.evaluate(async (opts) => {
    const canvas = document.createElement('canvas');
    canvas.width = opts.width;
    canvas.height = opts.height;
    const context = canvas.getContext('2d')!;

    const preferred = opts.prefer === 'webm'
      ? ['video/webm;codecs=vp8', 'video/webm']
      : [
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
    const mimeType = preferred.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';

    const stream = canvas.captureStream(opts.fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1_200_000,
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

    // One frame drawn before recording starts, so the first captured frame is
    // never a blank canvas.
    const draw = (elapsed: number): void => {
      const progress = Math.min(1, elapsed / opts.seconds);
      context.fillStyle = `hsl(${Math.floor(progress * 300)} 80% 50%)`;
      context.fillRect(0, 0, opts.width, opts.height);
      context.fillStyle = '#000000';
      context.fillRect(progress * (opts.width - 24), 0, 24, opts.height);
      context.fillStyle = '#ffffff';
      context.font = '20px monospace';
      context.fillText(elapsed.toFixed(2), 8, opts.height - 10);
    };

    draw(0);
    recorder.start();

    const started = performance.now();
    await new Promise<void>((resolve) => {
      // A timer rather than requestAnimationFrame: rAF can be throttled in a
      // backgrounded or headless page, and a fixture that is sometimes half
      // the length asked for is worse than one a fraction of a frame off.
      const timer = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        if (elapsed >= opts.seconds) {
          clearInterval(timer);
          resolve();
          return;
        }
        draw(elapsed);
      }, Math.round(1000 / opts.fps));
    });

    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());

    const blob = new Blob(chunks, { type: mimeType });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let binary = '';
    const CHUNK = 0x8000;
    for (let at = 0; at < bytes.length; at += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
    }
    return { base64: btoa(binary), mimeType };
  }, settings);

  return { bytes: Buffer.from(result.base64, 'base64'), mimeType: result.mimeType };
}
