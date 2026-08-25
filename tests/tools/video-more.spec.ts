import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { recordVideo } from '../../lib/browser-video';
import { isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { encodePng } from '../../lib/image-fixtures';

/**
 * Tool-level functional tests for the three remaining video tools: playing a
 * clip backwards, speeding one up, and building one out of pictures.
 *
 * The first of these is the interesting one to test. "Did this get reversed"
 * cannot be answered from the file's headers - a reversed clip and an
 * untouched one have the same length, the same size and the same track - so a
 * tool that quietly did nothing would pass every structural check. It has to
 * be answered from the pictures.
 *
 * The fixture's colour sweeps across the spectrum as it plays, so the frame at
 * the start is a different colour from the frame at the end. Sampling a frame
 * out of the result and comparing its hue with the source's is what turns
 * "backwards" into a number.
 */

const REVERSE = '/reverse-video/';
const TIMELAPSE = '/timelapse-video/';
const FROM_IMAGES = '/images-to-video/';

const WIDTH = 320;
const HEIGHT = 240;
const SECONDS = 3;

/** Record a clip on the open page and load it into the tool. */
async function loadClip(page: Page, path: string, seconds = SECONDS): Promise<Buffer> {
  await page.goto(path);
  const { bytes } = await recordVideo(page, {
    width: WIDTH, height: HEIGHT, seconds, fps: 20,
  });

  await page.locator('#file-input').setInputFiles({
    name: 'clip.mp4', mimeType: 'video/mp4', buffer: bytes,
  });
  await expect(page.locator('#source')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#src-length')).not.toHaveText('—', { timeout: 60_000 });
  return bytes;
}

/** Export and return the file the browser saved. */
async function exportVideo(page: Page, wait = 180_000): Promise<Buffer> {
  await expect(page.locator('#export')).toBeEnabled({ timeout: 60_000 });
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: wait });

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

/**
 * The average colour of a video's frame at a given time.
 *
 * Decoded in the page, because that is the only place there is a video
 * decoder. Only three numbers come back, so nothing large crosses the bridge.
 */
async function frameColour(
  page: Page,
  bytes: Buffer,
  atSeconds: number,
): Promise<{ r: number; g: number; b: number; duration: number }> {
  return page.evaluate(async ({ base64, atSeconds }) => {
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) array[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([array], { type: 'video/mp4' }));

    const video = document.createElement('video');
    video.muted = true;
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('the video would not load'));
    });

    const target = Math.min(Math.max(0, atSeconds), Math.max(0, video.duration - 0.05));
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = target;
    });

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(video, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);

    let r = 0; let g = 0; let b = 0; let count = 0;
    for (let at = 0; at < data.length; at += 4) {
      // The sweeping bar is black; skipping the very dark pixels keeps the
      // average about the background colour, which is the thing that moves
      // with time.
      if (data[at] + data[at + 1] + data[at + 2] < 90) continue;
      r += data[at]; g += data[at + 1]; b += data[at + 2];
      count += 1;
    }

    const duration = video.duration;
    URL.revokeObjectURL(url);
    if (count === 0) return { r: 0, g: 0, b: 0, duration };
    return { r: r / count, g: g / count, b: b / count, duration };
  }, { base64: bytes.toString('base64'), atSeconds });
}

/** How far apart two colours are, as a plain distance in RGB. */
const colourGap = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

test.describe('reverse-video: playing it backwards', () => {
  test('control: the clip\'s start and end are different colours', async ({ page }) => {
    // Everything below rests on this. If the fixture looked the same at both
    // ends, a tool that did nothing at all would pass the reversal test.
    // Run on the reverse-video page rather than the hub. Playing a blob: video
    // needs media-src blob:, which the site grants only to the tools that need
    // it - the hub's default-src 'none' refuses it, correctly, and the first
    // version of this test read that refusal as a broken fixture.
    test.setTimeout(180_000);
    await page.goto(REVERSE);
    const { bytes } = await recordVideo(page, {
      width: WIDTH, height: HEIGHT, seconds: SECONDS, fps: 20,
    });

    const start = await frameColour(page, bytes, 0.1);
    const end = await frameColour(page, bytes, SECONDS - 0.2);

    expect(colourGap(start, end), 'the fixture does not change colour as it plays')
      .toBeGreaterThan(60);
  });

  test('the reversed clip starts where the original ended', async ({ page }) => {
    // The check the headers cannot make. A reversed file and an untouched one
    // have the same length, size and track, so a tool that quietly passed the
    // input through would look correct in every structural test.
    test.setTimeout(300_000);
    const original = await loadClip(page, REVERSE);

    const reversed = await exportVideo(page);
    expect(isMp4(reversed), 'the reversed file is not an MP4').toBe(true);

    const originalStart = await frameColour(page, original, 0.1);
    const originalEnd = await frameColour(page, original, SECONDS - 0.3);
    const reversedStart = await frameColour(page, reversed, 0.1);

    // The start of the result should look like the end of the source...
    const toEnd = colourGap(reversedStart, originalEnd);
    const toStart = colourGap(reversedStart, originalStart);

    expect(toEnd, `reversed start is ${toEnd.toFixed(0)} from the source's end `
      + `and ${toStart.toFixed(0)} from its start - it was not reversed`)
      .toBeLessThan(toStart);
  });

  test('reversing keeps the size and roughly the length', async ({ page }) => {
    test.setTimeout(300_000);
    await loadClip(page, REVERSE);
    const reversed = await exportVideo(page);

    const track = videoTrack(readMp4(reversed));
    expect(track).not.toBeNull();
    expect(track!.width).toBe(WIDTH);
    expect(track!.height).toBe(HEIGHT);

    const { duration } = await frameColour(page, reversed, 0);
    expect(duration).toBeGreaterThan(SECONDS - 1);
    expect(duration).toBeLessThan(SECONDS + 1);
  });
});

test.describe('timelapse-video: speeding it up', () => {
  test('ten times faster is about a tenth as long', async ({ page }) => {
    // The one number this tool exists to apply. A time-lapse that came back
    // the same length as the source still plays, and looks like a tool that
    // worked until somebody checks the clock.
    test.setTimeout(300_000);
    await loadClip(page, TIMELAPSE);

    await page.locator('#speed').fill('10');
    await page.locator('#speed').blur();

    const bytes = await exportVideo(page);
    expect(isMp4(bytes)).toBe(true);

    const { duration } = await frameColour(page, bytes, 0);
    expect(duration, 'the time-lapse is not a tenth of the length')
      .toBeLessThan(SECONDS / 4);
    expect(duration, 'the time-lapse has no length at all').toBeGreaterThan(0.05);
  });

  test('a gentler speed gives a longer file than a faster one', async ({ page }) => {
    // The speed has to behave like a scale rather than a label.
    test.setTimeout(420_000);
    await loadClip(page, TIMELAPSE);
    await page.locator('#speed').fill('2');
    await page.locator('#speed').blur();
    const gentle = await exportVideo(page);

    await loadClip(page, TIMELAPSE);
    await page.locator('#speed').fill('20');
    await page.locator('#speed').blur();
    const fast = await exportVideo(page);

    const slow = await frameColour(page, gentle, 0);
    const quick = await frameColour(page, fast, 0);
    expect(slow.duration).toBeGreaterThan(quick.duration);
  });
});

test.describe('images-to-video: building one out of pictures', () => {
  /** Solid-colour PNGs, so each frame is tellable from the next. */
  function pictures(count: number): Array<{ name: string; buffer: Buffer }> {
    const colours: Array<[number, number, number]> = [
      [220, 40, 40], [40, 200, 60], [50, 80, 230], [230, 200, 40],
    ];
    return Array.from({ length: count }, (_, index) => ({
      name: `shot-${index}.png`,
      buffer: encodePng(640, 480, () => colours[index % colours.length]),
    }));
  }

  async function loadPictures(page: Page, count: number): Promise<void> {
    await page.goto(FROM_IMAGES);
    await page.locator('#file-input').setInputFiles(pictures(count).map((picture) => ({
      name: picture.name, mimeType: 'image/png', buffer: picture.buffer,
    })));
    await expect(page.locator('#file-list li, #image-list li').first())
      .toBeVisible({ timeout: 60_000 });
  }

  test('four pictures held a second each make a video of about four seconds', async ({ page }) => {
    test.setTimeout(300_000);
    await loadPictures(page, 4);

    await page.locator('#duration-unit').selectOption('seconds');
    await page.locator('#bulk-amount').fill('1');
    await page.locator('#apply-bulk').click();

    const bytes = await exportVideo(page);
    expect(isMp4(bytes), 'the result is not an MP4').toBe(true);

    const { duration } = await frameColour(page, bytes, 0);
    expect(duration, 'four one-second pictures should be about four seconds')
      .toBeGreaterThan(3);
    expect(duration).toBeLessThan(6);
  });

  test('the video is the size that was chosen', async ({ page }) => {
    test.setTimeout(300_000);
    await loadPictures(page, 2);
    // The control is #resolution; #size is a different tool's id.
    await page.locator('#resolution').selectOption('1280x720');

    const bytes = await exportVideo(page);
    const track = videoTrack(readMp4(bytes));

    expect(track).not.toBeNull();
    expect(track!.width).toBe(1280);
    expect(track!.height).toBe(720);
  });

  test('the pictures never leave the page', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(FROM_IMAGES);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const shots = pictures(2);
    await page.locator('#file-input').setInputFiles(shots.map((picture) => ({
      name: picture.name, mimeType: 'image/png', buffer: picture.buffer,
    })));
    await expect(page.locator('#file-list li, #image-list li').first())
      .toBeVisible({ timeout: 60_000 });
    await exportVideo(page);
    await page.waitForLoadState('networkidle');

    const marker = shots[0].buffer.toString('base64').slice(60, 140);
    for (const entry of traffic) {
      expect(entry, 'a picture was sent').not.toContain(marker);
    }
  });
});
