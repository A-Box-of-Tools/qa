import { chromium, type Page } from '@playwright/test';

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
 * Recordings already made by this worker, by their settings.
 *
 * A recording is wall-clock: a three-second clip costs three seconds however
 * fast the machine is, and it is the one cost in this suite that parallelism
 * cannot touch. Most tests only need "a clip", not "a freshly recorded clip",
 * so identical settings return the same bytes rather than paying the three
 * seconds again. Each Playwright worker is its own process, so the cache is
 * per worker and needs no locking.
 *
 * A test that truly needs two distinct recordings has only to vary the
 * settings - and none currently does: the tests that compare two files
 * compare a source against what a tool made from it, which caching serves
 * better, not worse, since the source is bit-for-bit the same both times.
 */
const recordings = new Map<string, { bytes: Buffer; mimeType: string }>();

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

  const key = JSON.stringify(settings);
  const cached = recordings.get(key);
  if (cached) return cached;

  // WebKit has no MediaRecorder, so the page under test cannot make the clip
  // when the suite is running in Safari's engine. The clip is only a fixture
  // - bytes handed to a tool - and the tool does not care which engine
  // encoded them, so one is borrowed from Chromium rather than giving up the
  // video tools on Safari entirely. That mattered: it was two hundred and
  // twenty-eight failures, none of them about the site.
  //
  // Once per worker, because the recording is cached above and a browser
  // launch is far more expensive than the recording it wraps.
  const canRecord = await page.evaluate(() => typeof MediaRecorder === 'function');
  if (!canRecord) {
    const lender = await chromium.launch();
    try {
      const borrowed = await lender.newPage();
      const made = await record(borrowed, settings);
      recordings.set(key, made);
      return made;
    } finally {
      await lender.close();
    }
  }

  const made = await record(page, settings);
  recordings.set(key, made);
  return made;
}

/** The recording itself, wherever it is being done. */
async function record(
  page: Page,
  settings: { width: number; height: number; seconds: number; fps: number; prefer: string },
): Promise<{ bytes: Buffer; mimeType: string }> {
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

/**
 * Skip a test that needs the browser to decode video, where it cannot.
 *
 * WebCodecs is how every video tool here reads frames, and the engine either
 * has it or does not: Playwright's WebKit build has no VideoDecoder,
 * VideoEncoder, MediaRecorder or OffscreenCanvas at all. The tools answer
 * that correctly - video-to-gif says "This browser has no WebCodecs, so
 * frames cannot be decoded" and stops - so there is nothing left to test
 * about turning a clip into anything.
 *
 * Worth saying that this is not a statement about Safari: 17 and newer do
 * have WebCodecs. It is a limit of the build this suite drives, so a skip
 * here means "this engine cannot", not "Safari cannot".
 *
 * The refusal itself is asserted in tests/tools/video.spec.ts, where it
 * belongs - a tool that cannot work should say so, and that is testable in
 * exactly the engine that cannot.
 */
export async function skipWithoutWebCodecs(page: Page): Promise<boolean> {
  return page.evaluate(() => typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'function');
}
