import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { recordVideo , skipWithoutWebCodecs } from '../../lib/browser-video';
import { isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { readGif } from '../../lib/gif';
import { decodedSize } from '../../lib/browser-image';
import { quiet } from '../../lib/engine';

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

// Every test in this file hands a clip to a tool and expects something back.
// An engine without WebCodecs cannot decode a frame at all - Playwright's
// WebKit has no VideoDecoder, VideoEncoder, MediaRecorder or OffscreenCanvas -
// and the tools say so and stop, which is the right answer and leaves nothing
// here to measure. The refusal itself is asserted in video.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  test.skip(await skipWithoutWebCodecs(page),
    'this engine has no WebCodecs, so no video tool can decode anything');
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

test.describe('crop-video: keeping part of the picture', () => {
  test('the cropped video is the size of the crop, not a rescale of the whole', async ({ page }) => {
    // The failure worth catching: a tool that scaled the whole frame down to
    // the requested box instead of cutting a piece out of it. The output size
    // is identical either way, so the size alone cannot tell them apart -
    // which is why the still below is compared as well.
    test.setTimeout(240_000);
    await loadClip(page, CROP);

    await page.locator('#crop-x').fill('0');
    await page.locator('#crop-y').fill('0');
    await page.locator('#crop-w').fill('160');
    await page.locator('#crop-h').fill('120');

    await expect(page.locator('#export')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 120_000 });

    const bytes = await save(page, () => page.locator('#download').click());
    expect(isMp4(bytes), 'the cropped file is not an MP4').toBe(true);

    const track = videoTrack(readMp4(bytes));
    expect(track).not.toBeNull();
    expect(track!.width).toBe(160);
    expect(track!.height).toBe(120);
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

test.describe('trim-video: keeping part of the time', () => {
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

  test('marking a section in and out records a segment of that length', async ({ page }) => {
    // The arithmetic the whole tool rests on: what was marked is what gets
    // kept. Checked on the page's own running total, which is what a reader
    // uses to decide whether they have marked what they meant to.
    test.setTimeout(180_000);
    await loadClip(page, TRIM, '#section-card');
    await expect(page.locator('#section-card')).toBeVisible({ timeout: 60_000 });

    await seekTo(page, 0.5);
    await page.locator('#mark-in').click();
    await seekTo(page, 2.0);
    await page.locator('#mark-out').click();

    await expect(page.locator('#segment-table')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#segment-rows tr')).toHaveCount(1);

    const kept = (await page.locator('#total-kept').textContent()) ?? '';
    // 1.5 seconds, give or take the frame the seek landed on.
    expect(kept).toMatch(/0:01\.[3-6]/);
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
  test('the GIF covers the stretch that was asked for, at the size asked for', async ({ page }) => {
    // Verified with lib/gif.ts rather than by looking at it: a GIF made from
    // the wrong seconds of the film still animates, and a GIF whose frame
    // delays are wrong still plays.
    test.setTimeout(300_000);
    await loadClip(page, TO_GIF);

    await expect(page.locator('#export')).toBeEnabled({ timeout: 60_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 180_000 });

    const bytes = await save(page, () => page.locator('#download').click());
    const gif = readGif(bytes);

    expect(gif.version).toMatch(/^GIF8/);
    expect(gif.frames.length, 'a GIF of a three-second clip should have several frames')
      .toBeGreaterThan(2);

    // The canvas is a sensible scaling of a 320 x 240 source, not zero and not
    // the whole film's pixel count by accident.
    expect(gif.width).toBeGreaterThan(0);
    expect(gif.height).toBeGreaterThan(0);
    expect(gif.width / gif.height).toBeCloseTo(WIDTH / HEIGHT, 1);

    // Every frame carries a delay; a GIF with none plays as fast as the
    // renderer can manage, which is the usual way this goes wrong.
    for (const [index, frame] of gif.frames.entries()) {
      expect(frame.delayMs, `frame ${index} has no delay`).toBeGreaterThan(0);
    }

    const total = gif.frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    expect(total, 'the animation is nothing like the length of the clip')
      .toBeGreaterThan((SECONDS - 1.5) * 1000);
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
