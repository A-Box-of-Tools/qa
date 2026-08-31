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
  /**
   * Give the clip a soundtrack.
   *
   * A tone from an oscillator, mixed into the recording as a second track.
   * Off by default and cached separately, so every test that wants a picture
   * and nothing else goes on getting the silent clip it always had.
   *
   * It exists for extract-audio-from-video, where a clip with no sound in it
   * is not a fixture but a different test: the tool's whole job is to find
   * the audio track, and it would refuse a silent file for the correct
   * reason while proving nothing about the job.
   */
  withSound?: boolean;
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
    withSound: options.withSound ?? false,
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
  settings: {
    width: number; height: number; seconds: number; fps: number;
    prefer: string; withSound: boolean;
  },
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

    // The soundtrack, when one was asked for. An oscillator through a
    // MediaStreamDestination is the only way to get a real audio track into a
    // MediaRecorder without a microphone, and a microphone is not something a
    // test runner has. 440 Hz at a quarter of full scale: loud enough to be
    // unmistakable in the samples that come back, quiet enough not to clip.
    let audio: { context: AudioContext; oscillator: OscillatorNode } | null = null;
    if (opts.withSound) {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const level = context.createGain();
      level.gain.value = 0.25;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(level).connect(destination);
      oscillator.start();
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      audio = { context, oscillator };
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 1_200_000,
    });

    const chunks: Blob[] = [];
    const hush = () => {
      if (!audio) return;
      audio.oscillator.stop();
      void audio.context.close();
      audio = null;
    };
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
    // The oscillator outlives the recording otherwise, and an AudioContext
    // left open in a page the next test reuses is a page that never goes
    // quiet.
    hush();

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

/**
 * Can this engine get pictures out of the fixture at all?
 *
 * A better question than `typeof VideoDecoder`, because the two come apart.
 * Playwright's WebKit answers differently on different platforms - the
 * Windows build has no VideoDecoder, VideoEncoder, MediaRecorder or
 * OffscreenCanvas, while the Linux build the CI runners use has WebCodecs and
 * still cannot decode H.264, which is what a browser MediaRecorder writes and
 * what every fixture in this suite therefore is. A name check passes there
 * and every test behind it then fails on a black frame, which is a hundred
 * minutes of CI saying "this engine has no codec" in the most expensive way
 * available.
 *
 * Asked with a bare <video> and a canvas, so the answer is the engine's and
 * not a tool's: if this returns false, nothing on the site could have got a
 * picture out of that file either.
 *
 * Two different frames rather than one non-black frame. A decoder that
 * produces the first frame and then stops - or a <video> that reports a size
 * it never paints - would pass "is this black", and a tool asked to reverse
 * such a clip has nothing to work with.
 */
export async function canDecodeVideo(
  page: Page,
  bytes: Buffer,
  mimeType = 'video/mp4',
): Promise<boolean> {
  return page.evaluate(async ({ data, mimeType }) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mimeType }));
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    try {
      const ready = new Promise<boolean>((resolve) => {
        video.onloadeddata = () => resolve(true);
        video.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 15_000);
      });
      video.src = url;
      if (!await ready) return false;
      if (!video.videoWidth || !video.duration || !Number.isFinite(video.duration)) return false;

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return false;

      const at = async (time: number) => {
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve();
          setTimeout(resolve, 10_000);
          video.currentTime = time;
        });
        context.drawImage(video, 0, 0);
        const middle = context.getImageData(
          Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1,
        ).data;
        return [middle[0], middle[1], middle[2]];
      };

      const first = await at(0.1);
      const later = await at(Math.max(0.2, video.duration - 0.2));
      return Math.abs(first[0] - later[0])
        + Math.abs(first[1] - later[1])
        + Math.abs(first[2] - later[2]) > 12;
    } finally {
      video.src = '';
      URL.revokeObjectURL(url);
    }
  }, { data: Array.from(bytes), mimeType });
}

/**
 * Can this engine write a video?
 *
 * The other half, for the tools that make one rather than read one. Either
 * road counts: images-to-video reaches for WebCodecs where it can and a
 * MediaRecorder where it cannot, so an engine with neither cannot produce a
 * file by any path open to the page.
 *
 * `isConfigSupported` is asked about H.264 at a small size because that is
 * what the tools ask for. An engine that has the class and supports no codec
 * is exactly the case a `typeof` check misses.
 *
 * AND THE ANSWER THAT NEVER COMES
 *
 * `VideoEncoder.isConfigSupported` does not always settle. On the WebKit build
 * CI runs it returns a promise that is still pending two minutes later - the
 * same build whose `VideoDecoder.isConfigSupported` answers immediately, which
 * is how video-to-gif passes there while nothing that encodes does.
 *
 * The first version of this awaited it and inherited the hang: nineteen tests
 * failed on a test timeout inside the probe that existed to skip them. So the
 * question is asked with a deadline, and no answer counts as no. That is the
 * right reading whatever the cause - a browser that cannot say within two
 * seconds whether it supports H.264 is not a browser that is about to encode
 * any.
 */
export async function canEncodeVideo(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const global = globalThis as {
      VideoEncoder?: {
        isConfigSupported?: (config: unknown) => Promise<{ supported?: boolean }>;
      };
      MediaRecorder?: { isTypeSupported?: (type: string) => boolean };
    };
    try {
      const asked = global.VideoEncoder?.isConfigSupported?.({
        codec: 'avc1.42001E', width: 320, height: 240,
      });
      const supported = await Promise.race([
        asked,
        new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 2_000); }),
      ]);
      if (supported?.supported) return true;
    } catch { /* an engine that throws here cannot encode either */ }
    const recorder = global.MediaRecorder;
    if (!recorder?.isTypeSupported) return false;
    return ['video/mp4;codecs=avc1', 'video/webm;codecs=vp8', 'video/webm']
      .some((type) => recorder.isTypeSupported!(type));
  });
}
