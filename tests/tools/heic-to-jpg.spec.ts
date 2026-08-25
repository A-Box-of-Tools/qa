import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { HEIC_HEIGHT, HEIC_WIDTH, fullSize, heicBytes } from '../../lib/heic';
import { decodedSize } from '../../lib/browser-image';
import { hasExif, metadataSegments } from '../../lib/jpeg-fixtures';

/**
 * Tool-level functional tests for HEIC to JPG.
 *
 * The one tool here whose input cannot be generated. As its README says, the
 * picture inside a HEIC is an HEVC frame, and every browser will decode HEVC
 * inside a <video> and refuse to decode it as a still - so there is no way to
 * make one in a browser, and a real photograph is committed instead.
 *
 * That photograph is what makes these tests worth writing. It is 4032 x 3024
 * and stored the way Apple stores them, as a grid of 512 x 512 tiles. A
 * converter that decoded the first tile and stopped would hand back a picture
 * that opens perfectly well, looks like a photograph, and is a sixty-fourth of
 * the one that went in. Nothing about the result would say so except its size.
 *
 * It also carries EXIF and no GPS, which is what lets the keep-or-drop setting
 * be checked in both directions.
 */

const URL_PATH = '/heic-to-jpg/';

/** Converting a twelve-megapixel HEIC through a vendored decoder is not quick. */
const PATIENT = 300_000;

async function load(page: Page, name = 'photo.heic'): Promise<Buffer> {
  const bytes = heicBytes();
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({
    name, mimeType: 'image/heic', buffer: bytes,
  });
  await expect(page.locator('#file-list li')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('#load-error')).toBeHidden();
  return bytes;
}

/** Convert with the current settings and return the file the browser saved. */
async function convert(page: Page): Promise<Buffer> {
  await expect(page.locator('#convert-all')).toBeEnabled({ timeout: 120_000 });
  await page.locator('#convert-all').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: PATIENT });

  const link = page.locator('#results a[download]').first();
  await expect(link).toBeVisible({ timeout: PATIENT });

  const pending = page.waitForEvent('download');
  await link.click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('heic-to-jpg: the fixture', () => {
  test('control: the photograph is a tiled HEIC of the size the tests expect', async ({ page }) => {
    // The control for the size assertion below, which is the whole point of
    // using a real Apple photograph rather than a single-tile one. If the
    // fixture were 512 x 512 to begin with, a converter that only ever
    // returned one tile would pass.
    const bytes = heicBytes();
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('heic');

    const size = fullSize(bytes);
    expect(size.width).toBe(HEIC_WIDTH);
    expect(size.height).toBe(HEIC_HEIGHT);

    // And it really is stored as tiles, so "decoded one tile" is a failure
    // this fixture can actually have.
    expect(bytes.includes(Buffer.from('grid', 'latin1')), 'not a tiled HEIC').toBe(true);

    // The premise of the whole tool: this browser cannot open it.
    const refused = await decodedSize(page, bytes, 'image/heic');
    expect(refused.width, 'this browser decoded a HEIC, which the tool assumes it cannot')
      .toBe(0);
  });
});

test.describe('heic-to-jpg: converting', () => {
  test('the JPEG is the whole photograph, not one tile of it', async ({ page }) => {
    test.setTimeout(PATIENT + 120_000);
    await load(page);

    const jpeg = await convert(page);
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const size = await decodedSize(page, jpeg, 'image/jpeg');
    expect(size.width, `the JPEG did not decode: ${size.error ?? ''}`).toBe(HEIC_WIDTH);
    expect(size.height, 'only part of the picture came out').toBe(HEIC_HEIGHT);
  });

  test('the result opens in the browser that could not open the source', async ({ page }) => {
    // The tool's entire reason for existing, stated as a test: the same
    // browser that refused the HEIC in the control above takes the JPEG.
    test.setTimeout(PATIENT + 120_000);
    const source = await load(page);

    expect((await decodedSize(page, source, 'image/heic')).width).toBe(0);

    const jpeg = await convert(page);
    expect((await decodedSize(page, jpeg, 'image/jpeg')).width).toBeGreaterThan(0);
  });

  test('asking for PNG gives a PNG', async ({ page }) => {
    test.setTimeout(PATIENT + 120_000);
    await load(page);
    await page.locator('#format-select').selectOption('image/png');

    const out = await convert(page);
    expect(out.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect((await decodedSize(page, out, 'image/png')).width).toBe(HEIC_WIDTH);
  });

  test('asking for WebP gives a WebP', async ({ page }) => {
    test.setTimeout(PATIENT + 120_000);
    await load(page);
    await page.locator('#format-select').selectOption('image/webp');

    const out = await convert(page);
    expect(out.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(out.subarray(8, 12).toString('latin1')).toBe('WEBP');
  });

  test('a lower quality gives a smaller file', async ({ page }) => {
    // The quality slider has to be a scale rather than a label, the same way
    // the compressor's presets do.
    test.setTimeout(PATIENT * 2);
    await load(page);
    await page.locator('#quality').fill('95');
    const high = await convert(page);

    await load(page);
    await page.locator('#quality').fill('55');
    const low = await convert(page);

    expect(low.length).toBeLessThan(high.length);
  });
});

test.describe('heic-to-jpg: the metadata it was asked to keep or drop', () => {
  test('keeping the EXIF really keeps it', async ({ page }) => {
    test.setTimeout(PATIENT + 120_000);
    await load(page);
    await page.locator('#keep-exif').check();

    const jpeg = await convert(page);
    expect(hasExif(jpeg), 'the EXIF was dropped despite being asked for').toBe(true);

    // And it is the photograph's own EXIF, not an empty block.
    expect(jpeg.includes(Buffer.from('Apple', 'latin1'))).toBe(true);
  });

  test('dropping the EXIF really drops it', async ({ page }) => {
    // The direction that matters for a reader who does not want the make,
    // model and capture time of their camera travelling with the picture.
    test.setTimeout(PATIENT + 120_000);
    await load(page);
    await page.locator('#keep-exif').uncheck();

    const jpeg = await convert(page);
    expect(hasExif(jpeg), 'EXIF survived a conversion that was told to drop it').toBe(false);

    // Nothing that merely looks like it, either: the tags are what identify
    // the device, and a segment the parser skipped would still be in the file.
    expect(jpeg.includes(Buffer.from('iPad Air', 'latin1'))).toBe(false);
    expect(jpeg.includes(Buffer.from('2022:11:08', 'latin1'))).toBe(false);

    // A stripped file should carry fewer metadata segments than a kept one.
    expect(metadataSegments(jpeg).length).toBeLessThan(4);
  });
});

test.describe('heic-to-jpg: the promise', () => {
  test('the photograph never leaves the page', async ({ page }) => {
    test.setTimeout(PATIENT + 120_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = await load(page, 'private.heic');
    await convert(page);
    await page.waitForLoadState('networkidle');

    const marker = bytes.toString('base64').slice(20_000, 20_080);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the photograph was sent').not.toContain(marker);
    }
  });
});
