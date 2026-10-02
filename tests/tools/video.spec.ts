import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { canDecodeVideo, recordVideo, skipWithoutWebCodecs } from '../../lib/browser-video';
import { boxesIn, findBox, findBoxes, isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { readGif } from '../../lib/gif';
import { decodedPixels, decodedSize, pixelAt } from '../../lib/browser-image';
import { ask, onAPageOfItsOwn, quiet } from '../../lib/engine';
import { canEncodeH264 } from '../../lib/held-video-flush';
import { sampleVideoFrames } from '../../lib/presented-video';

/**
 * Tool-level functional tests for the video tools: grabbing a frame, cropping,
 * cutting, and turning a clip into a GIF.
 *
 * Video is where a tool can most easily produce something that opens and is
 * wrong. A player will show whatever it is handed: a clip cut to the wrong
 * seconds still plays, a crop that quietly rescaled instead of cropping still
 * fills the window, and a GIF made from the wrong stretch of the film still
 * animates. None of it looks broken.
 *
 * The fixture is a real H.264 MP4 recorded by the browser under test (see
 * lib/browser-video.ts) - a colour that changes over time with a bar sweeping
 * across it, so one moment is visibly not another. Verification uses
 * lib/mp4.ts and lib/gif.ts, both written here: etoolbox carries its own MP4
 * reader in five tools, and asking one of those what a file contains would be
 * asking a tool to mark its own work.
 *
 * Durations are wall-clock recordings, so they land near the number asked for
 * rather than on it, and every assertion about time carries a tolerance. That
 * is the honest way to treat a recorded fixture, and the checks are still
 * tight enough to catch a tool that cut the wrong part.
 */

const GRAB = '/grab-frame/';
const CROP = '/crop-video/';
const TRIM = '/trim-video/';
const TO_GIF = '/video-to-gif/';

const WIDTH = 320;
const HEIGHT = 240;
const SECONDS = 3;

/**
 * Record a clip on whichever page is open, then load it into that tool.
 *
 * `ready` differs per tool and cannot be assumed: grab-frame, crop-video and
 * video-to-gif all show the same #source panel when they have read a file, and
 * trim-video has no such panel at all - it opens its editing section instead.
 * Waiting for #source on trim-video times out on a tool that is working
 * perfectly, which is how the first version of this helper failed three tests.
 */
async function loadClip(
  page: Page,
  path: string,
  ready = '#source',
  name = 'clip.mp4',
): Promise<Buffer> {
  await page.goto(path);
  const { bytes } = await recordVideo(page, {
    width: WIDTH, height: HEIGHT, seconds: SECONDS, fps: 20,
  });

  await page.locator('#file-input').setInputFiles({
    name, mimeType: 'video/mp4', buffer: bytes,
  });

  await expect(page.locator(ready)).toBeVisible({ timeout: 60_000 });
  // Once the metadata is in, the preview knows how long the film is.
  await page.waitForFunction(() => {
    const video = document.getElementById('preview') as HTMLVideoElement | null;
    return Boolean(video && Number.isFinite(video.duration) && video.duration > 0);
  }, undefined, { timeout: 60_000 });

  return bytes;
}

/** Click something that saves a file, and return the bytes. */
async function save(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

/**
 * Put the preview at a given time and wait for it to land there.
 *
 * For the tools that only read the <video> element's clock. Not enough for
 * grab-frame, which keeps its own playhead - see stepAlong below.
 */
async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => new Promise<void>((resolve) => {
    const video = document.getElementById('preview') as HTMLVideoElement;
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  }), seconds);
}

/**
 * Move grab-frame's playhead by dragging its scrubber, the way a reader does.
 *
 * Setting video.currentTime from outside does not move this tool: it tracks a
 * `position` of its own, updated by its goTo/goToFrame, and grabs from that.
 * A frame grabbed after an external seek is therefore still frame zero - which
 * is how the first version of this test managed to accuse a working tool of
 * returning the same picture twice.
 *
 * `fraction` is how far through the clip to go; the scrubber is a frame index
 * when the tool decoded the file exactly, and milliseconds when it did not, so
 * this works in proportions of the control's own range.
 */
async function scrubTo(page: Page, fraction: number): Promise<void> {
  await page.locator('#scrub').evaluate((element, f) => {
    const slider = element as HTMLInputElement;
    const min = Number(slider.min || 0);
    const max = Number(slider.max || 0);
    slider.value = String(Math.round(min + (max - min) * f));
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);

  // The tool decodes on the way to a frame; wait for it to finish.
  await expect(page.locator('#stage-busy')).toBeHidden({ timeout: 30_000 });
}

// Keep the older WebCodecs scenarios behind their existing prerequisite.
// Copy and its refusal guard need only native playback for their pixel oracle:
// probe the cached fixture before loading it into the app, so an app failure
// cannot be mistaken for a missing decoder.
test.beforeEach(async ({ page }, testInfo) => {
  await page.goto('/');
  if (testInfo.tags.includes('@native-playback')) {
    const { bytes } = await recordVideo(page, {
      width: WIDTH, height: HEIGHT, seconds: SECONDS, fps: 20,
    });
    test.skip(!isMp4(bytes), 'the recording engine did not produce the MP4 needed for byte-copy trimming');
    // The hub forbids blob media in its CSP. A native capability probe must
    // not inherit that page policy or mistake it for an unsupported decoder.
    const probe = await page.context().newPage();
    try {
      test.skip(!await canDecodeVideo(probe, bytes),
        'this engine cannot decode the fixture for the independent native playback oracle');
    } finally {
      await probe.close();
    }
    return;
  }
  test.skip(await skipWithoutWebCodecs(page),
    'this scenario requires the WebCodecs VideoDecoder API');
});

test.describe('the fixture itself', () => {
  test('control: the recording is a real MP4 of the size and length asked for', async ({ page }) => {
    // The control for every test below. A fixture that was secretly WebM, or
    // half a second long, would make correct tools look broken in ways that
    // are tedious to tell apart from real failures.
    test.setTimeout(180_000);
    await page.goto('/');
    const { bytes, mimeType } = await recordVideo(page, {
      width: WIDTH, height: HEIGHT, seconds: SECONDS, fps: 20,
    });

    expect(mimeType, 'this browser did not record MP4').toContain('mp4');
    expect(isMp4(bytes), 'the recording is not an MP4').toBe(true);

    const file = readMp4(bytes);
    const track = videoTrack(file);
    expect(track, 'the recording has no video track').not.toBeNull();
    expect(track!.width).toBe(WIDTH);
    expect(track!.height).toBe(HEIGHT);
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.6);
    expect(file.seconds).toBeLessThan(SECONDS + 0.6);
  });
});

test.describe('grab-frame: a still out of a film', () => {
  test('the grabbed frame is a picture at the video\'s own size', async ({ page }) => {
    test.setTimeout(180_000);
    await loadClip(page, GRAB);

    await page.locator('#grab').click();
    await expect(page.locator('#shots-card')).toBeVisible({ timeout: 30_000 });

    const shot = page.locator('#shots-card li').first();
    await expect(shot).toBeVisible({ timeout: 30_000 });

    const bytes = await save(page, () => shot.locator('a[download]').first().click());
    const size = await decodedSize(page, bytes, 'image/png');

    expect(size.width, `the still did not decode: ${size.error ?? ''}`).toBe(WIDTH);
    expect(size.height).toBe(HEIGHT);
  });

  test('two different moments give two different pictures', async ({ page }) => {
    // The fixture's colour changes over time on purpose. A tool that always
    // grabbed frame zero would hand back the same picture twice and nothing
    // on the page would say so.
    test.setTimeout(180_000);
    await loadClip(page, GRAB);

    await scrubTo(page, 0);
    await page.locator('#grab').click();
    await expect(page.locator('#shots-card li')).toHaveCount(1, { timeout: 30_000 });

    await scrubTo(page, 0.85);
    await page.locator('#grab').click();
    await expect(page.locator('#shots-card li')).toHaveCount(2, { timeout: 30_000 });

    const shots = page.locator('#shots-card li');
    const first = await save(page, () => shots.nth(0).locator('a[download]').first().click());
    const second = await save(page, () => shots.nth(1).locator('a[download]').first().click());

    expect(first.equals(second), 'both grabs returned the same frame').toBe(false);
  });
});

/** Compare the saved crop with source coordinates, using fresh native players. */
async function cropPixelError(page: Page, source: Buffer, output: Buffer) {
  return page.evaluate(async ({ source, output }) => {
    const read = async (encoded: string) => {
      const bytes = Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      // Presented-frame callbacks need a painted player. It is removed after
      // sampling, including when the native decoder refuses the file.
      video.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:240px;z-index:2147483647';
      document.body.append(video);
      const wait = (event: 'loadeddata' | 'seeked', action: () => void) => new Promise<void>((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          video.removeEventListener(event, done);
          video.removeEventListener('error', failed);
        };
        const done = () => { clean(); resolve(); };
        const failed = () => { clean(); reject(new Error(`video failed before ${event}`)); };
        const timer = setTimeout(() => { clean(); reject(new Error(`video never reached ${event}`)); }, 15_000);
        video.addEventListener(event, done);
        video.addEventListener('error', failed);
        action();
      });
      try {
        await wait('loadeddata', () => { video.src = url; });
        const target = 0.75;
        if (!Number.isFinite(video.duration) || video.duration <= target) {
          throw new Error('the crop fixture ended before the sampled frame');
        }
        await new Promise<void>((resolve, reject) => {
          let seeked = false;
          let presented = typeof video.requestVideoFrameCallback !== 'function';
          let callback = 0;
          let animation = 0;
          let settling = false;
          const clean = () => {
            clearTimeout(timer);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', failed);
            if (callback) video.cancelVideoFrameCallback(callback);
            cancelAnimationFrame(animation);
          };
          const fail = (message: string) => { clean(); reject(new Error(message)); };
          const failed = () => fail('the crop fixture failed while seeking');
          const ready = () => {
            if (!seeked || !presented || settling) return;
            settling = true;
            // seeked can precede the canvas-visible frame. Let presentation
            // settle; this is also the fallback when rVFC is unavailable.
            animation = requestAnimationFrame(() => {
              animation = requestAnimationFrame(() => {
                if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
                  || Math.abs(video.currentTime - target) > 0.001) {
                  fail('the crop fixture was not ready at the requested time');
                  return;
                }
                clean();
                resolve();
              });
            });
          };
          const onSeeked = () => { seeked = true; ready(); };
          const frame = (_: number, metadata: VideoFrameCallbackMetadata) => {
            // This fixture is recorded at 20 fps. Reject the old poster frame,
            // allowing one frame interval plus timestamp-rounding tolerance.
            if (metadata.mediaTime <= target + 0.005 && target - metadata.mediaTime <= 0.055) {
              presented = true;
              ready();
            } else {
              callback = video.requestVideoFrameCallback(frame);
            }
          };
          const timer = setTimeout(() => fail('the crop fixture never presented the requested frame'), 15_000);
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('error', failed);
          if (!presented) callback = video.requestVideoFrameCallback(frame);
          video.currentTime = target;
        });
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(video, 0, 0);
        return { width: canvas.width, height: canvas.height,
          pixels: context.getImageData(0, 0, canvas.width, canvas.height).data };
      } finally {
        video.removeAttribute('src');
        video.load();
        video.remove();
        URL.revokeObjectURL(url);
      }
    };
    const before = await read(source);
    const after = await read(output);
    let crop = 0;
    let scaled = 0;
    let samples = 0;
    // The requested crop is the top-left 160 x 120. The moving black bar
    // lies inside it at this instant but would land at half the x coordinate
    // if the whole 320 x 240 picture were merely scaled down.
    for (let y = 12; y < 108; y += 8) {
      for (let x = 4; x < 156; x += 4) {
        const actual = (y * after.width + x) * 4;
        const wanted = (y * before.width + x) * 4;
        const wrong = (Math.floor(y * before.height / after.height) * before.width
          + Math.floor(x * before.width / after.width)) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          crop += Math.abs(after.pixels[actual + channel] - before.pixels[wanted + channel]);
          scaled += Math.abs(after.pixels[actual + channel] - before.pixels[wrong + channel]);
          samples += 1;
        }
      }
    }
    return { crop: crop / samples, scaled: scaled / samples };
  }, { source: source.toString('base64'), output: output.toString('base64') });
}

test.describe('crop-video: keeping part of the picture', () => {
  test('the cropped video is the size of the crop, not a rescale of the whole', async ({ page }) => {
    // The failure worth catching: a tool that scaled the whole frame down to
    // the requested box instead of cutting a piece out of it. The output size
    // is identical either way, so the size alone cannot tell them apart -
    // which is why the still below is compared as well.
    test.setTimeout(240_000);
    const original = await loadClip(page, CROP);
    test.skip(!await canDecodeVideo(page, original),
      'this engine cannot decode the fixture for the independent pixel oracle');

    await page.locator('#crop-x').fill('0');
    await page.locator('#crop-y').fill('0');
    await page.locator('#crop-w').fill('160');
    await page.locator('#crop-h').fill('120');
    await page.locator('#crop-h').blur();

    await expect(page.locator('#export')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 120_000 });

    const bytes = await save(page, () => page.locator('#download').click());
    expect(isMp4(bytes), 'the cropped file is not an MP4').toBe(true);

    const track = videoTrack(readMp4(bytes));
    expect(track).not.toBeNull();
    expect(track!.width).toBe(160);
    expect(track!.height).toBe(120);
    const error = await cropPixelError(page, original, bytes);
    expect(error.crop, 'saved pixels must match the selected source coordinates').toBeLessThan(12);
    expect(error.scaled - error.crop, 'the output must distinguish a crop from whole-frame rescaling')
      .toBeGreaterThan(8);
  });

  test('the cropped video still plays, and for about as long', async ({ page }) => {
    test.setTimeout(240_000);
    await loadClip(page, CROP);

    await page.locator('#crop-x').fill('40');
    await page.locator('#crop-y').fill('40');
    await page.locator('#crop-w').fill('240');
    await page.locator('#crop-h').fill('160');

    await expect(page.locator('#export')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 120_000 });
    const bytes = await save(page, () => page.locator('#download').click());

    // Cropping takes nothing off the length.
    const playable = await page.evaluate(async (base64) => {
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) array[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([array], { type: 'video/mp4' }));
      const video = document.createElement('video');
      return new Promise<{ duration: number; width: number; height: number }>((resolve) => {
        video.onloadedmetadata = () => resolve({
          duration: video.duration, width: video.videoWidth, height: video.videoHeight,
        });
        video.onerror = () => resolve({ duration: 0, width: 0, height: 0 });
        video.src = url;
      });
    }, bytes.toString('base64'));

    expect(playable.width, 'the cropped video would not play').toBe(240);
    expect(playable.height).toBe(160);
    expect(playable.duration).toBeGreaterThan(SECONDS - 0.8);
  });
});

/** A typed commit replaces the row, so locators are resolved after each blur. */
async function typeVideoPart(page: Page, start: string, end: string): Promise<void> {
  await page.locator('#add-segment').click();
  const row = page.locator('#segment-rows tr').last();
  await row.locator('.segment-time').nth(0).fill(start);
  await row.locator('.segment-time').nth(0).blur();
  await row.locator('.segment-time').nth(1).fill(end);
  await row.locator('.segment-time').nth(1).blur();
}

/** Use the shared presentation barrier without changing the trimmer's pixel oracle. */
async function savedVideoFrames(page: Page, bytes: Buffer, times: number[]) {
  return sampleVideoFrames(page, bytes, times);
}

/**
 * Native seeking across a multi-entry edit list is approximate in Chromium
 * (also documented by the tool). Observe real sequentially presented frames
 * instead, retaining their media timestamps when the runner misses a callback.
 */
async function playedVideoFrames(page: Page, bytes: Buffer, targets: number[]) {
  return page.evaluate(async ({ data, targets }) => {
    const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: 'video/mp4' }));
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.playbackRate = 0.5;
    // A presented-frame callback needs a rendered video, not a hidden scratch
    // element. This temporary player is removed even if decoding fails.
    video.style.cssText = 'position:fixed;top:0;left:0;width:320px;height:240px;z-index:2147483647';
    document.body.append(video);
    let callback = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<{ duration: number; frames: Array<{ time: number; colour: number[] }> }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('sequential video sampling did not finish within 20 seconds')), 20_000);
        video.onerror = () => reject(new Error('the downloaded video failed during sequential playback'));
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        const frames: Array<{ time: number; colour: number[] }> = [];
        const frame = (_: number, metadata: VideoFrameCallbackMetadata) => {
          const target = targets[frames.length];
          if (metadata.mediaTime >= target) {
            // Sampling a later interval would stop checking this one at all.
            if (metadata.mediaTime - target >= 0.25) {
              reject(new Error(`no presented frame observed near ${target}s; first was ${metadata.mediaTime}s`));
              return;
            }
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0);
            const pixels = [0.15, 0.5, 0.85].map((x) => context.getImageData(
              Math.floor(x * canvas.width), Math.floor(canvas.height / 4), 1, 1,
            ).data);
            frames.push({ time: metadata.mediaTime, colour: [0, 1, 2].map((channel) =>
              pixels.map((pixel) => pixel[channel]).sort((a, b) => a - b)[1]) });
            if (frames.length === targets.length) {
              resolve({ duration: video.duration, frames });
              return;
            }
          }
          callback = video.requestVideoFrameCallback(frame);
        };
        video.onended = () => reject(new Error('the downloaded video ended before every retained interval was sampled'));
        video.onloadeddata = () => {
          callback = video.requestVideoFrameCallback(frame);
          void video.play().catch(reject);
        };
        video.src = url;
      });
    } finally {
      clearTimeout(timer);
      video.cancelVideoFrameCallback(callback);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  }, { data: Array.from(bytes), targets });
}

interface EncodedVideoSample { pts: number; duration: number; data: Buffer }

/** Read the fixture/output sample tables here, independently of the tool. */
function encodedVideoSamples(bytes: Buffer): { timescale: number; samples: EncodedVideoSample[] } {
  const track = findBoxes(bytes, 'trak').find((box) => {
    const handler = findBox(bytes, 'hdlr', box.dataStart, box.end)!;
    return bytes.toString('latin1', handler.dataStart + 8, handler.dataStart + 12) === 'vide';
  })!;
  const box = (type: string) => findBox(bytes, type, track.dataStart, track.end)!;
  const mdhd = box('mdhd').dataStart;
  const timescale = bytes.readUInt32BE(mdhd + (bytes[mdhd] === 1 ? 20 : 12));
  const samples: EncodedVideoSample[] = [];
  const fragments = boxesIn(bytes).filter((entry) => entry.type === 'moof');
  if (fragments.length) {
    // The silent MediaRecorder fixture has one track. trun carries each sample
    // size and duration, so no encoded payload or timing comes from site code.
    expect(readMp4(bytes).tracks).toHaveLength(1);
    for (const fragment of fragments) {
      const tfhd = findBox(bytes, 'tfhd', fragment.dataStart, fragment.end)!.dataStart;
      const flags = bytes.readUInt32BE(tfhd) & 0xffffff;
      let field = tfhd + 8;
      let base = fragment.start;
      if (flags & 1) { base = Number(bytes.readBigUInt64BE(field)); field += 8; }
      if (flags & 2) field += 4;
      const defaultDuration = flags & 8 ? bytes.readUInt32BE(field) : 0;
      if (flags & 8) field += 4;
      const defaultSize = flags & 16 ? bytes.readUInt32BE(field) : 0;
      const tfdt = findBox(bytes, 'tfdt', fragment.dataStart, fragment.end)!.dataStart;
      let dts = bytes[tfdt] === 1 ? Number(bytes.readBigUInt64BE(tfdt + 4)) : bytes.readUInt32BE(tfdt + 4);
      let offset = 0;
      for (const run of findBoxes(bytes, 'trun', fragment.dataStart, fragment.end)) {
        const at = run.dataStart;
        const runFlags = bytes.readUInt32BE(at) & 0xffffff;
        const count = bytes.readUInt32BE(at + 4);
        let cursor = at + 8;
        if (runFlags & 1) { offset = base + bytes.readInt32BE(cursor); cursor += 4; }
        if (runFlags & 4) cursor += 4;
        for (let i = 0; i < count; i += 1) {
          const duration = runFlags & 0x100 ? bytes.readUInt32BE(cursor) : defaultDuration;
          if (runFlags & 0x100) cursor += 4;
          const size = runFlags & 0x200 ? bytes.readUInt32BE(cursor) : defaultSize;
          if (runFlags & 0x200) cursor += 4;
          if (runFlags & 0x400) cursor += 4;
          const composition = runFlags & 0x800
            ? (bytes[at] === 1 ? bytes.readInt32BE(cursor) : bytes.readUInt32BE(cursor)) : 0;
          if (runFlags & 0x800) cursor += 4;
          expect(duration).toBeGreaterThan(0);
          expect(size).toBeGreaterThan(0);
          samples.push({ pts: dts + composition, duration, data: bytes.subarray(offset, offset + size) });
          dts += duration;
          offset += size;
        }
      }
    }
    return { timescale, samples };
  }
  const expandRuns = (type: string): number[] => {
    const table = findBox(bytes, type, track.dataStart, track.end);
    if (!table) return [];
    const at = table.dataStart;
    const result: number[] = [];
    for (let i = 0; i < bytes.readUInt32BE(at + 4); i += 1) {
      const count = bytes.readUInt32BE(at + 8 + i * 8);
      const value = type === 'ctts' && bytes[at] === 1
        ? bytes.readInt32BE(at + 12 + i * 8) : bytes.readUInt32BE(at + 12 + i * 8);
      result.push(...Array<number>(count).fill(value));
    }
    return result;
  };
  const durations = expandRuns('stts');
  const compositions = expandRuns('ctts');
  const stsz = box('stsz').dataStart;
  const fixed = bytes.readUInt32BE(stsz + 4);
  const stsc = box('stsc').dataStart;
  const runs = Array.from({ length: bytes.readUInt32BE(stsc + 4) }, (_, i) => ({
    first: bytes.readUInt32BE(stsc + 8 + i * 12), count: bytes.readUInt32BE(stsc + 12 + i * 12),
  }));
  const stco = box('stco').dataStart;
  let sample = 0;
  let dts = 0;
  for (let chunk = 1; chunk <= bytes.readUInt32BE(stco + 4); chunk += 1) {
    let offset = bytes.readUInt32BE(stco + 4 + chunk * 4);
    const run = [...runs].reverse().find((entry) => entry.first <= chunk)!;
    for (let i = 0; i < run.count; i += 1) {
      const size = fixed || bytes.readUInt32BE(stsz + 12 + sample * 4);
      samples.push({ pts: dts + (compositions[sample] ?? 0), duration: durations[sample], data: bytes.subarray(offset, offset + size) });
      dts += durations[sample];
      offset += size;
      sample += 1;
    }
  }
  expect(samples).toHaveLength(bytes.readUInt32BE(stsz + 8));
  return { timescale, samples };
}

/** Probe the fixture's actual H.264 configuration without consulting the tool. */
async function canDecodeFixtureWebCodecs(page: Page, bytes: Buffer): Promise<boolean> {
  const stsd = findBox(bytes, 'stsd')!;
  const entry = boxesIn(bytes, stsd.dataStart + 8, stsd.end)[0];
  expect(['avc1', 'avc3']).toContain(entry.type);
  const avcC = boxesIn(bytes, entry.dataStart + 78, entry.end).find((box) => box.type === 'avcC')!;
  expect(avcC, 'the recording fixture must carry its H.264 decoder configuration').toBeDefined();
  const description = bytes.subarray(avcC.dataStart, avcC.end);
  const codec = `${entry.type}.${description.subarray(1, 4).toString('hex')}`;
  const width = bytes.readUInt16BE(entry.dataStart + 24);
  const height = bytes.readUInt16BE(entry.dataStart + 26);
  const first = encodedVideoSamples(bytes).samples[0].data;
  return ask(page, `decode-webcodecs:${codec}:${width}:${height}:${description.toString('hex')}`,
    () => onAPageOfItsOwn(page, (own) => own.evaluate(async ({ codec, width, height, description, first }) => {
      if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') return false;
      const config = { codec, codedWidth: width, codedHeight: height, description: new Uint8Array(description) };
      let decoder: VideoDecoder | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!(await VideoDecoder.isConfigSupported(config)).supported) return false;
        let frames = 0;
        let failed = false;
        decoder = new VideoDecoder({ output: (frame) => { frames += 1; frame.close(); }, error: () => { failed = true; } });
        decoder.configure(config);
        decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: new Uint8Array(first) }));
        const flushed = await Promise.race([
          decoder.flush().then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
        ]);
        return flushed && !failed && frames > 0;
      } catch { return false; }
      finally {
        clearTimeout(timer);
        if (decoder && decoder.state !== 'closed') decoder.close();
      }
    }, { codec, width, height, description: Array.from(description), first: Array.from(first) })), false);
}

function expectCopiedIntervals(original: Buffer, saved: Buffer, ranges: Array<[number, number]>): void {
  const source = encodedVideoSamples(original);
  const output = encodedVideoSamples(saved);
  const elst = findBox(saved, 'elst')!.dataStart;
  expect(saved[elst], 'this writer emits version-zero edit lists').toBe(0);
  expect(saved.readUInt32BE(elst + 4)).toBe(ranges.length);
  const identities = new Map<string, EncodedVideoSample[]>();
  for (const sample of source.samples) {
    const key = sample.data.toString('base64');
    identities.set(key, [...(identities.get(key) ?? []), sample]);
  }
  for (const [index, [start, end]] of ranges.entries()) {
    const entry = elst + 8 + index * 12;
    const duration = saved.readUInt32BE(entry) / 1000;
    const from = saved.readInt32BE(entry + 4) / output.timescale;
    expect(saved.readUInt32BE(entry + 8), 'edit rate is one').toBe(0x10000);
    expect(Math.abs(duration - (end - start))).toBeLessThanOrEqual(0.001);
    const visible = output.samples.filter((sample) =>
      (sample.pts + sample.duration) / output.timescale > from && sample.pts / output.timescale < from + duration);
    expect(visible.length, `interval ${index} has encoded pictures`).toBeGreaterThan(1);
    for (const sample of visible) {
      const expectedTime = start + sample.pts / output.timescale - from;
      const matches = identities.get(sample.data.toString('base64')) ?? [];
      expect(matches.some((input) => Math.abs(input.pts / source.timescale - expectedTime)
        < 2 / Math.min(source.timescale, output.timescale)),
      `interval ${index} contains the original encoded frame at ${expectedTime}s`).toBe(true);
    }
  }
}

function colourDistance(a: number[], b: number[]): number {
  return Math.max(...a.map((value, channel) => Math.abs(value - b[channel])));
}

async function saveCopiedVideo(page: Page): Promise<Buffer> {
  await expect(page.locator('#method option[value="copy"]')).toBeEnabled();
  await page.locator('#method').selectOption('copy');
  await expect(page.locator('#export')).toBeEnabled();
  await page.locator('#export').click();
  await expect(page.locator('#download')).toBeVisible({ timeout: 120_000 });
  return save(page, () => page.locator('#download').click());
}

test.describe('trim-video: keeping part of the time', () => {
  test('the downloaded copy preserves reordered parts when only the first needs preroll', { tag: '@native-playback' }, async ({ page }) => {
    test.setTimeout(240_000);
    const original = await loadClip(page, TRIM, '#section-card');
    expect(await page.locator('#preview').evaluate((element) => (element as HTMLVideoElement).duration),
      'the recording fixture must extend beyond both typed parts').toBeGreaterThan(2.5);
    await typeVideoPart(page, '0:00.000', '0:00.500');
    await typeVideoPart(page, '0:01.750', '0:02.500');
    await page.locator('#segment-rows tr').nth(1).getByRole('button', { name: 'Move up', exact: true }).click();
    await expect(page.locator('#segment-rows tr').first().locator('.segment-time').first())
      .toHaveValue('0:01.750');
    const bytes = await saveCopiedVideo(page);

    // mdhd can include keyframe pre-roll. mvhd and a native player's visible
    // duration must describe only the .75 + .5 seconds the reader requested.
    const file = readMp4(bytes);
    expect(file.seconds).toBeCloseTo(1.25, 2);
    expect(videoTrack(file)?.width).toBe(WIDTH);
    expect(videoTrack(file)?.height).toBe(HEIGHT);
    test.skip(!await page.evaluate(() => 'requestVideoFrameCallback' in HTMLVideoElement.prototype),
      'this engine cannot report timestamps of sequentially presented frames');
    const actual = await playedVideoFrames(page, bytes, [0.20, 0.55, 0.95]);
    const sourceTimes = actual.frames.map(({ time }) => time < 0.75 ? time + 1.75 : time - 0.75);
    const expected = await savedVideoFrames(page, original, sourceTimes);
    expect(actual.duration).toBeCloseTo(1.25, 1);
    expectCopiedIntervals(original, bytes, [[1.75, 2.5], [0, 0.5]]);
    expect(colourDistance(expected.colours[0], expected.colours[2]),
      'the fixture must distinguish the later and earlier parts').toBeGreaterThan(80);
    for (let i = 0; i < actual.frames.length; i += 1) {
      expect(colourDistance(actual.frames[i].colour, expected.colours[i]),
        `saved Copy frame at ${actual.frames[i].time}s belongs to source ${sourceTimes[i]}s`).toBeLessThan(40);
    }
  });

  test('cut mode refuses internal Copy preroll and explicitly exports Exact with the requested timing', { tag: '@native-playback' }, async ({ page }) => {
    test.setTimeout(240_000);
    const original = await loadClip(page, TRIM, '#section-card');
    expect(await page.locator('#preview').evaluate((element) => (element as HTMLVideoElement).duration),
      'the recording fixture must extend beyond both typed parts').toBeGreaterThan(2.5);
    await typeVideoPart(page, '0:00.500', '0:01.000');
    await typeVideoPart(page, '0:01.500', '0:02.000');
    await page.locator('input[name="mode"][value="cut"]').check();
    await expect(page.locator('#method option[value="copy"]')).toBeDisabled();
    await expect(page.locator('#method')).toHaveValue('copy');
    await expect(page.locator('#export')).toBeDisabled();
    const exactLabel = (await page.locator('#method option[value="exact"]').textContent())!.trim();
    await expect(page.locator('#copy-note')).toHaveText(
      `These sections cannot be copied reliably in browsers. Choose ${exactLabel} to preserve their timing.`);
    await expect(page.locator('#copy-note')).toBeVisible();
    test.skip(!await canDecodeFixtureWebCodecs(page, original),
      'an independent native WebCodecs decoder cannot decode the fixture');
    test.skip(!await canEncodeH264(page),
      'an independent native WebCodecs encoder does not support H.264');
    await expect(page.locator('#method option[value="exact"]')).toBeEnabled();
    await page.locator('#method').selectOption('exact');
    await expect(page.locator('#export')).toBeEnabled();
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 120_000 });
    const bytes = await save(page, () => page.locator('#download').click());

    test.skip(!await page.evaluate(() => 'requestVideoFrameCallback' in HTMLVideoElement.prototype),
      'this engine cannot report timestamps of sequentially presented frames');
    const actual = await playedVideoFrames(page, bytes, [0.20, 0.70, 1.20]);
    const sourceTimes = actual.frames.map(({ time }) => time < 0.5 ? time : time < 1 ? time + 0.5 : time + 1);
    const expected = await savedVideoFrames(page, original, sourceTimes);
    const seconds = expected.duration - 1;
    expect(Math.abs(readMp4(bytes).seconds - seconds)).toBeLessThan(0.075);
    expect(Math.abs(actual.duration - seconds)).toBeLessThan(0.075);
    const written = readMp4(bytes);
    expect(videoTrack(written)?.width).toBe(WIDTH);
    expect(videoTrack(written)?.height).toBe(HEIGHT);
    expect(findBox(bytes, 'elst'), 'silent Exact output contains no hidden video preroll').toBeNull();
    const pictures = encodedVideoSamples(bytes);
    expect(pictures.samples.length).toBeGreaterThan(25);
    expect(pictures.samples[0].pts).toBe(0);
    expect(pictures.samples.every((sample) => sample.pts / pictures.timescale < seconds + 0.075)).toBe(true);
    for (let i = 0; i < actual.frames.length; i += 1) {
      expect(colourDistance(actual.frames[i].colour, expected.colours[i]),
        `saved frame at ${actual.frames[i].time}s belongs to source ${sourceTimes[i]}s`).toBeLessThan(40);
    }
  });

  test('the tool reads the clip and reports its real length', async ({ page }) => {
    test.setTimeout(180_000);
    await loadClip(page, TRIM, '#section-card');

    await expect(page.locator('#section-card')).toBeVisible({ timeout: 60_000 });

    const total = (await page.locator('#tl-total').textContent()) ?? '';
    // 0:02.9xx - near three seconds, and definitely not zero.
    expect(total).toMatch(/0:0[23]\./);

    const shown = await page.evaluate(() => {
      const video = document.getElementById('preview') as HTMLVideoElement;
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
    });
    expect(shown.width).toBe(WIDTH);
    expect(shown.height).toBe(HEIGHT);
    expect(shown.duration).toBeGreaterThan(SECONDS - 0.8);
  });

  test('marking a section snaps to the actual nearest frames and reports their exact length', async ({ page }) => {
    // MediaRecorder may skip frames under load: a nominal 20 fps recording
    // once jumped from .249 to .733 seconds. The nearest mark to .5 was .733,
    // correctly, so a fixed 1.3–1.6s duration range accused the tool of a bug.
    test.setTimeout(180_000);
    const original = await loadClip(page, TRIM, '#section-card');
    await expect(page.locator('#section-card')).toBeVisible({ timeout: 60_000 });
    const encoded = encodedVideoSamples(original);
    const times = encoded.samples.map(({ pts }) => pts / encoded.timescale).sort((a, b) => a - b);
    expect(times.length, 'the fixture must contain actual picture timestamps').toBeGreaterThan(2);
    expect(times.at(-1), 'the fixture must extend beyond the last mark').toBeGreaterThan(2);
    // A linear distance comparison is independent of the timeline's binary
    // search; earlier timestamps win an exact tie, as the control promises.
    const nearest = (clock: number) => times.reduce((best, time) =>
      Math.abs(time - clock) < Math.abs(best - clock) ? time : best);
    const clockSeconds = (text: string) => text.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
    const mark = async (requested: number, button: string) => {
      await seekTo(page, requested);
      const clock = await page.locator('#preview').evaluate((element) => {
        const video = element as HTMLVideoElement;
        video.pause();
        return video.currentTime;
      });
      expect(clock, 'the native clock must settle at the requested mark').toBeCloseTo(requested, 3);
      await page.locator(button).click();
      return { requested, clock, frame: nearest(clock) };
    };
    const start = await mark(0.5, '#mark-in');
    const end = await mark(2, '#mark-out');
    await expect(page.locator('#segment-table')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#segment-rows tr')).toHaveCount(1);
    const inputs = page.locator('#segment-rows .segment-time');
    const shownStart = clockSeconds(await inputs.nth(0).inputValue());
    const shownEnd = clockSeconds(await inputs.nth(1).inputValue());
    const kept = clockSeconds((await page.locator('#total-kept').textContent()) ?? '');
    await test.info().attach('trim-mark-timestamps.json', {
      body: JSON.stringify({ timescale: encoded.timescale, times, start, end, shownStart, shownEnd, kept }, null, 2),
      contentType: 'application/json',
    });
    // The control rounds to the nearest millisecond; the oracle retains the
    // original clock precision when subtracting the two endpoints.
    expect(Math.abs(shownStart - start.frame)).toBeLessThanOrEqual(0.000501);
    expect(Math.abs(shownEnd - end.frame)).toBeLessThanOrEqual(0.000501);
    expect(Math.abs(kept - (end.frame - start.frame))).toBeLessThanOrEqual(0.000501);
  });

  test('undo takes the mark back', async ({ page }) => {
    test.setTimeout(180_000);
    await loadClip(page, TRIM, '#section-card');
    await expect(page.locator('#section-card')).toBeVisible({ timeout: 60_000 });

    await seekTo(page, 0.4);
    await page.locator('#mark-in').click();
    await seekTo(page, 1.4);
    await page.locator('#mark-out').click();
    await expect(page.locator('#segment-rows tr')).toHaveCount(1);

    await page.locator('#undo').click();
    await expect(page.locator('#segment-rows tr')).toHaveCount(0);
  });
});

test.describe('video-to-gif: a clip as an animation', () => {
  test('changing the selected end during capture preserves the started GIF duration and loop setting', async ({ page }) => {
    test.setTimeout(300_000);
    const original = await loadClip(page, TO_GIF);
    test.skip(!isMp4(original), 'the fixture must be MP4 for this direct decoder regression');
    test.skip(!await canDecodeFixtureWebCodecs(page, original),
      'an independent native WebCodecs decoder cannot decode the fixture');
    await page.locator('#end-time').fill('0:01.000');
    await page.locator('#end-time').blur();
    await page.locator('#width').selectOption('240');
    await page.locator('#fps').selectOption('10');
    await page.locator('#loop').check();
    // Hold completion of the real decoder flush, after its frames have been
    // delivered, without substituting invented frames for the fixture.
    await page.evaluate(() => {
      const original = VideoDecoder.prototype.flush;
      const state = { held: false, ready: false, release: () => {} };
      (window as unknown as { gifCapture: typeof state }).gifCapture = state;
      VideoDecoder.prototype.flush = async function () {
        await original.call(this);
        if (state.held) return;
        state.held = true;
        await new Promise<void>((resolve) => { state.release = resolve; state.ready = true; });
      };
    });
    // This case deliberately exercises the WebCodecs path; the fixture's own
    // codec support is established independently before relying on that path.
    await expect(page.locator('#src-path')).toContainText(/direct|reader|WebCodecs/i);
    await page.locator('#export').click();
    await page.waitForFunction(() => (window as unknown as { gifCapture: { ready: boolean } }).gifCapture.ready);
    await page.locator('#end-time').fill('0:02.500');
    await page.locator('#end-time').blur();
    await page.locator('#loop').uncheck();
    await page.evaluate(() => (window as unknown as { gifCapture: { release: () => void } }).gifCapture.release());
    await expect(page.locator('#download')).toBeVisible({ timeout: 180_000 });
    const bytes = await save(page, () => page.locator('#download').click());
    const gif = readGif(bytes);
    expect(gif.frames.reduce((sum, frame) => sum + frame.delayMs, 0)).toBe(1000);
    expect(bytes.includes(Buffer.from('NETSCAPE2.0', 'ascii')), 'the started export keeps its loop extension').toBe(true);
    await expect(page.locator('#end-time')).toHaveValue('0:02.500');
    await expect(page.locator('#loop')).not.toBeChecked();
  });

  test('the GIF covers the chosen second at 10 fps and a width of 240 pixels', async ({ page }) => {
    test.setTimeout(300_000);
    const original = await loadClip(page, TO_GIF);
    test.skip(!await canDecodeVideo(page, original),
      'this engine cannot decode the fixture for the independent first-frame oracle');
    await page.locator('#start-time').fill('0:00.500');
    await page.locator('#start-time').blur();
    await page.locator('#end-time').fill('0:01.500');
    await page.locator('#end-time').blur();
    await page.locator('#width').selectOption('240');
    await page.locator('#fps').selectOption('10');

    await expect(page.locator('#export')).toBeEnabled({ timeout: 60_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 180_000 });
    const bytes = await save(page, () => page.locator('#download').click());
    const gif = readGif(bytes);
    expect([gif.width, gif.height]).toEqual([240, 180]);
    // A delayed fixture capture can repeat a sampled picture, which GIF may
    // coalesce. It may not invent more than the ten requested instants or
    // turn this changing one-second section into a nearly static image.
    expect(gif.frames.length).toBeGreaterThanOrEqual(8);
    expect(gif.frames.length).toBeLessThanOrEqual(10);
    expect(gif.frames.every((frame) => frame.delayMs >= 100)).toBe(true);
    const total = gif.frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    expect(Math.abs(total - 1000), 'the chosen section must last one second').toBeLessThanOrEqual(10);

    const source = await savedVideoFrames(page, original, [0.5]);
    const first = await decodedPixels(page, bytes, 'image/gif');
    expect([first.width, first.height]).toEqual([240, 180]);
    const pixels = [0.15, 0.5, 0.85].map((x) => pixelAt(first, Math.floor(x * first.width), Math.floor(first.height / 4)));
    const colour = [0, 1, 2].map((channel) => pixels.map((pixel) => pixel[channel]).sort((a, b) => a - b)[1]);
    expect(colourDistance(colour, source.colours[0]), 'the GIF must start at the selected source moment')
      .toBeLessThan(40);
  });

  test('the GIF it writes is one a browser will play', async ({ page }) => {
    test.setTimeout(300_000);
    await loadClip(page, TO_GIF);

    await expect(page.locator('#export')).toBeEnabled({ timeout: 60_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 180_000 });
    const bytes = await save(page, () => page.locator('#download').click());

    const size = await decodedSize(page, bytes, 'image/gif');
    expect(size.width, `the GIF did not decode: ${size.error ?? ''}`).toBeGreaterThan(0);
  });
});

test.describe('the video tools: the promise', () => {
  test('the film never leaves the page', async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto(GRAB);
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    // The standard fixture rather than a shorter one, so this recording is
    // the cached clip every other test in the file already made.
    const { bytes } = await recordVideo(page, {
      width: WIDTH, height: HEIGHT, seconds: SECONDS, fps: 20,
    });
    await page.locator('#file-input').setInputFiles({
      name: 'private.mp4', mimeType: 'video/mp4', buffer: bytes,
    });
    await expect(page.locator('#source')).toBeVisible({ timeout: 60_000 });
    await page.locator('#grab').click();
    await expect(page.locator('#shots-card')).toBeVisible({ timeout: 30_000 });
    await quiet(page);

    const marker = bytes.toString('base64').slice(2000, 2080);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the film was sent').not.toContain(marker);
    }
  });
});
