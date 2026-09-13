import { test, expect, type Page } from '@playwright/test';
import { canEncodeVideo } from '../../lib/browser-video';
import { audioTrack, isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { loadTheExample, pressChip, runAndSave } from '../../lib/tool-frame';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the video compressor.
 *
 * WHAT THE TOOL PROMISES
 *
 * "The number is the point": a video under a number of megabytes, with as
 * little lost as the number allows. The picture is decoded, drawn smaller if
 * the number wants it, and encoded again; the sound is copied through
 * untouched; the result is measured and, if it missed, encoded once more.
 *
 * WHAT IS CHECKED, AND WITH WHAT
 *
 * The number, first and last: the file the browser saved is measured here
 * and held under the target the page shows in its own box, in the page's own
 * unit (a mebibyte, per src/plan.js). Then that it is still the clip - the
 * same length, an H.264 picture no bigger than the source and with even
 * edges, and the sound track still there when it was not asked to go - all
 * read with lib/mp4.ts rather than from the result block, whose check line
 * is required to be green and then ignored.
 *
 * The example is eight seconds of 960 x 540 with AAC sound, a little over a
 * megabyte and a half; the targets are the page's own relative chips, which
 * cannot be under the floor at which the page refuses.
 */

const URL_PATH = '/compress-video/';

const SHIPPED = discoverTools().includes('compress-video');
const NOT_YET = 'this site does not ship compress-video yet';

const WIDTH = 960;
const HEIGHT = 540;
const SECONDS = 8;
/** The page's megabyte, from src/plan.js. */
const MB = 1024 * 1024;

/**
 * Press a relative chip and read the target it put in the box, in bytes.
 *
 * Not through pressChip: a relative chip writes a rounded figure into the
 * box and then does not count itself as pressed, because the box no longer
 * holds exactly the fraction it computed. The number in the box is what the
 * page will hold itself to, so it is what this holds the page to.
 */
async function targetOf(page: Page, fraction: string): Promise<number> {
  await page.locator(`.chip[data-fraction="${fraction}"]`).click();
  const mb = Number(await page.locator('#target-mb').inputValue());
  expect(mb, 'the chip put no number in the target box').toBeGreaterThan(0);
  return mb * MB;
}

test.describe('compress-video: the clip it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page),
      'this engine can write no video, so the example cannot be built and nothing can be encoded smaller');
    await page.goto(URL_PATH);
    await loadTheExample(page);
  });

  test('half the size comes out under half the size, and is still the clip', async ({ page }) => {
    test.setTimeout(420_000);

    const target = await targetOf(page, '0.5');
    await expect(page.locator('#estimate'), 'the page made no plan for the number')
      .toContainText(/should come out near/i);

    // Two passes are allowed for, and each is a full encode.
    const bytes = await runAndSave(page, { timeout: 360_000 });

    // The whole job.
    expect(bytes.length, `the file is ${bytes.length} bytes, over the ${target} asked for`)
      .toBeLessThanOrEqual(target);
    expect(isMp4(bytes), 'the compressed file is not an MP4').toBe(true);

    const file = readMp4(bytes);
    const video = videoTrack(file);
    expect(video, 'no video track in the result').not.toBeNull();
    expect(video!.codec).toBe('avc1');
    expect(video!.width).toBeLessThanOrEqual(WIDTH);
    expect(video!.height).toBeLessThanOrEqual(HEIGHT);
    expect(video!.width % 2, 'an odd frame width').toBe(0);
    expect(video!.height % 2, 'an odd frame height').toBe(0);
    expect(video!.width / video!.height).toBeCloseTo(WIDTH / HEIGHT, 1);
    expect(video!.samples, 'frames went missing').toBe(SECONDS * 25);
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.6);
    expect(file.seconds).toBeLessThan(SECONDS + 0.6);

    // The sound is copied, not encoded: still AAC, still all there.
    const sound = audioTrack(file);
    expect(sound, 'the sound was lost').not.toBeNull();
    expect(sound!.codec).toBe('mp4a');
    expect(sound!.seconds).toBeGreaterThan(SECONDS - 1);
  });

  test('a quarter, with the sound left out', async ({ page }) => {
    test.setTimeout(420_000);

    await page.locator('#drop-audio').check();
    const target = await targetOf(page, '0.25');

    const bytes = await runAndSave(page, { timeout: 360_000 });
    expect(bytes.length).toBeLessThanOrEqual(target);

    const file = readMp4(bytes);
    expect(audioTrack(file), 'the sound track is still there').toBeNull();
    expect(videoTrack(file)?.samples).toBe(SECONDS * 25);
  });

  test('a number the clip is already under is not a job, and the page says so', async ({ page }) => {
    // The file is a little over a megabyte and a half; a hundred megabytes
    // is not compression. The last card must stay asleep rather than
    // encode the clip into something larger.
    await pressChip(page, '[data-mb="100"]');
    await expect(page.locator('#estimate')).toContainText(/already under/i);
    await expect(page.locator('#run-card')).toHaveAttribute('inert', '');
  });
});
