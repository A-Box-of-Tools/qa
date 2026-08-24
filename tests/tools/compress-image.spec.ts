import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { noisyJpeg, realJpeg } from '../../lib/browser-jpeg';
import { decodedSize } from '../../lib/browser-image';

/**
 * Tool-level functional tests for the Image Compressor.
 *
 * The promise here is a number: compress this picture to under 500 KB. That is
 * unusual on this site, and it is the reason to test at the file level - a
 * tool can say "done" while handing back something over the target, and the
 * only place that shows is the upload form that rejects it later.
 *
 * So every test measures the saved file: is it actually under the target, is
 * it still an image, and is it still the right shape.
 */

const URL_PATH = '/compress-image/';

/**
 * A photograph big enough that hitting a small target takes real work.
 *
 * Noise rather than shapes, deliberately. A drawing of flat rectangles on a
 * gradient compresses to about 40 KB at this size - already under any target
 * worth asking for - so the tool correctly hands it back untouched and every
 * assertion below becomes a comparison of a file with itself. That is exactly
 * how the first version of this spec failed: "expected < 43805, received
 * 43805".
 */
async function bigPhoto(page: Page, seed = 30): Promise<Buffer> {
  return noisyJpeg(page, 1600, 1200, seed);
}

async function load(page: Page, images: Array<{ name: string; bytes: Buffer }>): Promise<void> {
  await page.locator('#file-input').setInputFiles(images.map((image) => ({
    name: image.name,
    mimeType: 'image/jpeg',
    buffer: image.bytes,
  })));
  await expect(page.locator('#file-list li')).toHaveCount(images.length, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Compress and return every file the page offers. */
async function compress(page: Page): Promise<Buffer[]> {
  await expect(page.locator('#compress-all')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#compress-all').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 90_000 });

  const links = page.locator('#results a[download]');
  await expect(links.first()).toBeVisible({ timeout: 90_000 });

  const count = await links.count();
  const out: Buffer[] = [];
  for (let i = 0; i < count; i += 1) {
    const pending = page.waitForEvent('download');
    await links.nth(i).click();
    const saved = await pending;
    const path = await saved.path();
    if (!path) throw new Error('the browser saved no file');
    out.push(fs.readFileSync(path));
  }
  return out;
}

/** Type a target size in KB. */
async function target(page: Page, kb: number): Promise<void> {
  await page.locator('#target-unit').selectOption('KB');
  await page.locator('#target-value').fill(String(kb));
}

test.describe('compress-image: the target is a target', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('the file that comes back is under the size that was asked for', async ({ page }) => {
    test.setTimeout(180_000);

    const photo = await bigPhoto(page);
    await load(page, [{ name: 'photo.jpg', bytes: photo }]);
    await target(page, 120);

    const [out] = await compress(page);
    const kb = out.length / 1024;

    expect(kb, `came back at ${kb.toFixed(1)} KB against a 120 KB target`)
      .toBeLessThanOrEqual(120);
    expect(out.length, 'the result is smaller than the source, at least').toBeLessThan(photo.length);
  });

  test('a tighter target gives a smaller file than a looser one', async ({ page }) => {
    // If both landed on the same size the number would be decoration.
    test.setTimeout(180_000);
    const photo = await bigPhoto(page, 31);

    await load(page, [{ name: 'photo.jpg', bytes: photo }]);
    await target(page, 300);
    const [loose] = await compress(page);

    await page.goto(URL_PATH);
    await load(page, [{ name: 'photo.jpg', bytes: photo }]);
    await target(page, 80);
    const [tight] = await compress(page);

    expect(tight.length).toBeLessThan(loose.length);
    expect(tight.length / 1024).toBeLessThanOrEqual(80);
    expect(loose.length / 1024).toBeLessThanOrEqual(300);
  });

  test('the result is still a picture, and still the same shape', async ({ page }) => {
    // Meeting a byte target by handing back something that no longer decodes,
    // or that was quietly cropped, would satisfy the number and nothing else.
    test.setTimeout(180_000);

    await load(page, [{ name: 'photo.jpg', bytes: await bigPhoto(page, 32) }]);
    await target(page, 150);

    const [out] = await compress(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width, `the result did not decode: ${size.error ?? ''}`).toBeGreaterThan(0);
    expect(size.width / size.height).toBeCloseTo(1600 / 1200, 1);
  });

  test('asking for WebP gives a WebP', async ({ page }) => {
    test.setTimeout(180_000);

    await load(page, [{ name: 'photo.jpg', bytes: await bigPhoto(page, 33) }]);
    await target(page, 150);
    await page.locator('#format-select').selectOption('image/webp');

    const [out] = await compress(page);
    // RIFF....WEBP
    expect(out.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(out.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect((await decodedSize(page, out, 'image/webp')).width).toBeGreaterThan(0);
  });

  test('every picture in a batch meets the target', async ({ page }) => {
    test.setTimeout(240_000);

    await load(page, [
      { name: 'one.jpg', bytes: await noisyJpeg(page, 1200, 900, 34) },
      { name: 'two.jpg', bytes: await noisyJpeg(page, 900, 1200, 35) },
    ]);
    await target(page, 100);

    const files = await compress(page);
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const [index, file] of files.slice(0, 2).entries()) {
      expect(file.length / 1024, `image ${index} missed the target`).toBeLessThanOrEqual(100);
    }
  });
});

test.describe('compress-image: the promise', () => {
  test('the picture never leaves the page', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const photo = await bigPhoto(page, 36);
    await load(page, [{ name: 'private.jpg', bytes: photo }]);
    await target(page, 200);
    await compress(page);
    await page.waitForLoadState('networkidle');

    const marker = photo.toString('base64').slice(500, 580);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});
