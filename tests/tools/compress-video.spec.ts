import { test, expect, type Page } from '@playwright/test';
import { canEncodeAac, canEncodeVideo } from '../../lib/browser-video';
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
 * and held under the target in the page's own box, in the page's own unit
 * (a mebibyte, per src/plan.js). Then that it is still the clip - the same
 * frames, about the same length, an H.264 picture no bigger than the source
 * with even edges - read with lib/mp4.ts rather than from the result block,
 * whose check line is required to be green and then ignored.
 *
 * WHICH CLIP
 *
 * The site's own silent example clip, built in the page by the module the
 * tool's example button uses - but without the sound track that button adds,
 * because that is written with an AAC AudioEncoder that Chromium on the
 * Linux runners does not have, so the button's clip cannot exist there. The
 * clip itself is the right one: a photograph-like picture panning slowly, six
 * seconds of 960 x 540 at about a megabyte and a half, which is footage a
 * compressor can do something with. A recording from lib/browser-video.ts is
 * not: its flat colour and one bar come out under 200 KB for six seconds at
 * any bitrate, and a clip that small has nothing under it to aim at.
 *
 * The button's clip is used, on the engines that can build it, for the one
 * thing the silent one cannot show - that a sound track is copied through.
 */

const URL_PATH = '/compress-video/';

const SHIPPED = discoverTools().includes('compress-video');
const NOT_YET = 'this site does not ship compress-video yet';

/** The page's megabyte, from src/plan.js. */
const MB = 1024 * 1024;

/** The silent example: 960 x 540, 25 a second. */
const WIDTH = 960;
const HEIGHT = 540;
const FPS = 25;
const SECONDS = 6;

/**
 * Build the site's silent example clip in the page and hand it to the picker
 * as a file, the way a drop would. Returns its size.
 */
async function loadTheSilentExample(page: Page): Promise<number> {
  const size = await page.evaluate(async (seconds) => {
    // Resolved by the browser against the tool's page, which is why the
    // specifier is a variable: this is not a module of this suite's own.
    const specifier = './src/shared/example-video.js';
    const module = await import(specifier) as {
      exampleVideoFile(name: string, options: { seconds: number }): Promise<File>;
    };
    const file = await module.exampleVideoFile('clip.mp4', { seconds });
    const input = document.getElementById('file-input') as HTMLInputElement;
    const handed = new DataTransfer();
    handed.items.add(file);
    input.files = handed.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return file.size;
  }, SECONDS);
  await expect(page.locator('#file-row')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#load-error'), 'the tool refused the silent example').toBeHidden();
  expect(size, 'the silent example came out too small to be worth compressing')
    .toBeGreaterThan(400_000);
  return size;
}

/** Type a target into the box and read back what the page holds itself to. */
async function setTarget(page: Page, bytes: number): Promise<number> {
  const mb = Math.floor((bytes / MB) * 100) / 100;
  await page.locator('#target-mb').fill(String(mb));
  return mb * MB;
}

test.describe('compress-video: the silent example', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page),
      'this engine can write no video, so the clip cannot be built and nothing can be encoded smaller');
    await page.goto(URL_PATH);
  });

  test('half the size comes out under half the size, and is still the clip', async ({ page }) => {
    test.setTimeout(420_000);
    const size = await loadTheSilentExample(page);
    await expect(page.locator('#load-note'), 'a silent clip was not called silent')
      .toContainText(/no sound/i);

    const target = await setTarget(page, size * 0.5);
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
    expect(video!.samples, 'frames went missing').toBe(SECONDS * FPS);
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.6);
    expect(file.seconds).toBeLessThan(SECONDS + 0.6);
    expect(audioTrack(file), 'a silent clip came back with a sound track').toBeNull();
  });

  test('a quarter of the size, at a frame size the number chose', async ({ page }) => {
    test.setTimeout(420_000);
    const size = await loadTheSilentExample(page);
    const target = await setTarget(page, size * 0.25);

    const bytes = await runAndSave(page, { timeout: 360_000 });
    expect(bytes.length).toBeLessThanOrEqual(target);
    const video = videoTrack(readMp4(bytes));
    expect(video).not.toBeNull();
    expect(video!.width).toBeLessThanOrEqual(WIDTH);
    expect(video!.width % 2).toBe(0);
    expect(video!.samples).toBe(SECONDS * FPS);
  });

  test('a number the clip is already under is not a job, and the page says so', async ({ page }) => {
    // A hundred megabytes is not compression. The last card must stay
    // asleep rather than encode the clip into something larger.
    test.setTimeout(180_000);
    await loadTheSilentExample(page);
    await pressChip(page, '[data-mb="100"]');
    await expect(page.locator('#estimate')).toContainText(/already under/i);
    await expect(page.locator('#run-card')).toHaveAttribute('inert', '');
  });
});

test.describe('compress-video: the clip it ships with, which has sound', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('the sound is copied through untouched, under the number', async ({ page }) => {
    test.setTimeout(420_000);
    test.skip(!await canEncodeVideo(page), 'this engine can write no video');
    test.skip(!await canEncodeAac(page),
      'this engine has no AAC encoder, so the example clip - which is built with one - cannot exist here');
    await page.goto(URL_PATH);
    await loadTheExample(page);

    // The page's own relative chip: half the file, whatever the file is.
    await page.locator('.chip[data-fraction="0.5"]').click();
    const mb = Number(await page.locator('#target-mb').inputValue());
    expect(mb, 'the chip put no number in the target box').toBeGreaterThan(0);

    const bytes = await runAndSave(page, { timeout: 360_000 });
    expect(bytes.length).toBeLessThanOrEqual(mb * MB);

    const file = readMp4(bytes);
    const sound = audioTrack(file);
    expect(sound, 'the sound was lost').not.toBeNull();
    expect(sound!.codec, 'the sound was encoded again, not copied').toBe('mp4a');
    expect(sound!.seconds).toBeGreaterThan(7);
    expect(videoTrack(file)?.samples, 'frames went missing').toBe(8 * 25);
  });
});
