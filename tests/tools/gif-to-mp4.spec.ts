import { test, expect } from '@playwright/test';
import { canEncodeVideo } from '../../lib/browser-video';
import { writeGif, type FixtureGifFrame } from '../../lib/gif';
import { audioTrack, isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { loadFile, loadTheExample, runAndSave } from '../../lib/tool-frame';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the GIF to MP4 converter.
 *
 * WHAT THE TOOL PROMISES
 *
 * "The timing is the point." A GIF has no frame rate - each frame carries its
 * own delay - and most converters pick a rate and resample on to it, doubling
 * some frames and dropping others. This one writes one MP4 sample per GIF
 * frame, lasting exactly as long as the GIF said, with the one liberty every
 * browser takes: a delay under two hundredths of a second is played as ten.
 *
 * WHAT IS CHECKED, AND WITH WHAT
 *
 * That promise is a fact about the MP4's time-to-sample table, and lib/mp4.ts
 * reads it: every sample's duration on the track's own clock. So the second
 * test hands the tool a GIF written by lib/gif.ts with delays chosen to be
 * awkward - a tenth, a hundredth, half a second, a whole one, a fifth - and
 * requires the MP4's samples to last exactly those, with the hundredth
 * played as a tenth. The example the page ships covers the ordinary case:
 * twenty-four frames at eight hundredths, one sample each, the length the
 * GIF plays.
 */

const URL_PATH = '/gif-to-mp4/';

const SHIPPED = discoverTools().includes('gif-to-mp4');
const NOT_YET = 'this site does not ship gif-to-mp4 yet';

/** The example: 400 x 300, twenty-four frames, eight hundredths each. */
const EXAMPLE = { width: 400, height: 300, frames: 24, delayMs: 80 };

/** A tolerance of half a tick on the 90 kHz clock is generous; this is a millisecond. */
const CLOSE = 0.001;

test.describe('gif-to-mp4: the animation it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page),
      'this engine can write no video, so there is nothing to convert a GIF into');
    await page.goto(URL_PATH);
  });

  test('one MP4 sample per frame, as long as the GIF plays, no sound', async ({ page }) => {
    test.setTimeout(240_000);
    await loadTheExample(page);
    await expect(page.locator('#file-facts')).toContainText(`${EXAMPLE.frames} frames`);

    const bytes = await runAndSave(page);
    expect(isMp4(bytes), 'the result is not an MP4').toBe(true);

    const file = readMp4(bytes);
    const video = videoTrack(file);
    expect(video, 'no video track in the result').not.toBeNull();
    expect(video!.codec).toBe('avc1');
    expect(video!.width).toBe(EXAMPLE.width);
    expect(video!.height).toBe(EXAMPLE.height);
    expect(video!.samples, 'not one sample per GIF frame').toBe(EXAMPLE.frames);

    const played = (EXAMPLE.frames * EXAMPLE.delayMs) / 1000;
    expect(video!.seconds).toBeGreaterThan(played - 0.05);
    expect(video!.seconds).toBeLessThan(played + 0.05);
    for (const [index, seconds] of video!.durations.entries()) {
      expect(Math.abs(seconds - EXAMPLE.delayMs / 1000),
        `frame ${index} lasts ${seconds}s, not ${EXAMPLE.delayMs / 1000}s`).toBeLessThan(CLOSE);
    }

    // A GIF has no sound and the MP4 must not invent any.
    expect(audioTrack(file)).toBeNull();
  });

  test('frames with their own delays keep them, and a too-short one plays as a tenth', async ({ page }) => {
    test.setTimeout(240_000);

    // Even edges on purpose, so the tool has no reason to add a line of
    // background and the frame size can be asserted exactly.
    const width = 64;
    const height = 48;
    const palette: Array<[number, number, number]> = [
      [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255],
    ];
    const delays = [100, 10, 500, 1000, 200];
    const frames: FixtureGifFrame[] = delays.map((delayMs, n) => {
      const indices = new Uint8Array(width * height);
      indices.fill(n + 1);
      return { indices, delayMs };
    });
    const gif = writeGif(width, height, palette, frames);

    await loadFile(page, { name: 'awkward.gif', mimeType: 'image/gif', buffer: gif });
    await expect(page.locator('#file-facts')).toContainText(`${delays.length} frames`);
    await expect(page.locator('#plan-line'), 'the page did not notice the delays vary')
      .toContainText(/own timing|varies|kept frame for frame/i);

    const video = videoTrack(readMp4(await runAndSave(page)));
    expect(video).not.toBeNull();
    expect(video!.width).toBe(width);
    expect(video!.height).toBe(height);
    expect(video!.samples).toBe(delays.length);

    // The hundredth is the liberty: played as a tenth, as every browser does.
    const expected = delays.map((ms) => (ms < 20 ? 100 : ms) / 1000);
    expect(video!.durations.length).toBe(expected.length);
    for (const [index, seconds] of expected.entries()) {
      expect(Math.abs(video!.durations[index] - seconds),
        `frame ${index} lasts ${video!.durations[index]}s, not ${seconds}s`).toBeLessThan(CLOSE);
    }
    const total = expected.reduce((sum, s) => sum + s, 0);
    expect(video!.seconds).toBeGreaterThan(total - 0.01);
    expect(video!.seconds).toBeLessThan(total + 0.01);
  });
});

test.describe('gif-to-mp4: what it refuses', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('something that is not a GIF is refused, and said so', async ({ page }) => {
    await page.goto(URL_PATH);
    await page.locator('#file-input').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    await expect(page.locator('#load-error')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#run-card'), 'the last card woke for a file that was refused')
      .toHaveAttribute('inert', '');
  });
});
