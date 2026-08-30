import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { realJpeg } from '../../lib/browser-jpeg';
import { readImages, readPages } from '../../lib/pdf';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for Images to PDF.
 *
 * Its README states the point of the tool plainly: "Almost every 'images to
 * PDF' service decodes your photograph and compresses it again on the way in.
 * That is not a limitation of PDF." PDF's /DCTDecode filter means *these bytes
 * are a JPEG, hand them to the decoder*, so an image that is already a JPEG
 * can be copied in unchanged - no decode, no second pass of lossy
 * compression, no loss. The page even counts them: "9 of 12 put in exactly as
 * they were".
 *
 * A re-encoding tool produces a PDF that looks identical on screen and is
 * quietly worse, and the count on the page would be a claim nobody checked.
 * So the central test here pulls the image stream back out of the finished
 * PDF and compares it, byte for byte, with the JPEG that went in.
 */

const URL_PATH = '/images-to-pdf/';

/** Put images on the list and wait for them to be counted. */
async function load(page: Page, images: Array<{ name: string; bytes: Buffer }>): Promise<void> {
  await page.locator('#file-input').setInputFiles(images.map((image) => ({
    name: image.name,
    mimeType: image.name.endsWith('.png') ? 'image/png' : 'image/jpeg',
    buffer: image.bytes,
  })));

  await expect(page.locator('#image-list li')).toHaveCount(images.length, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Create the PDF and return the bytes the browser saved. */
async function create(page: Page): Promise<Buffer> {
  await expect(page.locator('#export')).toBeEnabled({ timeout: 20_000 });
  const pending = page.waitForEvent('download');
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30_000 });
  await page.locator('#download').click();

  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('images-to-pdf: the point of it', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('a JPEG is carried in byte for byte, not decoded and recompressed', async ({ page }) => {
    // The claim the whole tool is built around. Anything that decoded this
    // photograph and encoded it again would still produce a PDF that opens
    // and looks right - and would have thrown away quality that cannot come
    // back. Comparing the embedded stream with the source file is the only
    // check that can tell the two apart.
    const jpeg = await realJpeg(page, 320, 240, 1);
    await load(page, [{ name: 'photo.jpg', bytes: jpeg }]);

    const pdf = await create(page);
    const images = readImages(pdf);

    expect(images).toHaveLength(1);
    expect(images[0].filter, 'the image was not stored as a JPEG stream')
      .toMatch(/DCTDecode/);
    expect(images[0].data.length, 'the embedded stream is a different length')
      .toBe(jpeg.length);
    expect(images[0].data.equals(jpeg), 'the JPEG was re-encoded on the way in')
      .toBe(true);
  });

  test('the page says how many were copied untouched, and means it', async ({ page }) => {
    const images = await Promise.all([
      realJpeg(page, 200, 150, 2),
      realJpeg(page, 240, 180, 3),
      realJpeg(page, 160, 120, 4),
    ]);
    await load(page, images.map((bytes, i) => ({ name: `photo-${i}.jpg`, bytes })));

    // Three JPEGs in, so the count on the page should be three...
    await expect(page.locator('#sum-copied')).toContainText('3');

    // ...and the file should agree with the page.
    const embedded = readImages(await create(page));
    expect(embedded).toHaveLength(3);
    for (const [index, image] of embedded.entries()) {
      expect(image.data.equals(images[index]), `image ${index} was re-encoded`).toBe(true);
    }
  });

  test('one page per image, in the order they were given', async ({ page }) => {
    const images = await Promise.all([
      realJpeg(page, 300, 200, 5),
      realJpeg(page, 200, 300, 6),
    ]);
    await load(page, images.map((bytes, i) => ({ name: `p${i}.jpg`, bytes })));

    await expect(page.locator('#sum-pages')).toContainText('2');

    const pdf = await create(page);
    expect(readPages(pdf)).toHaveLength(2);

    const embedded = readImages(pdf);
    expect(embedded[0].width).toBe(300);
    expect(embedded[0].height).toBe(200);
    expect(embedded[1].width).toBe(200);
    expect(embedded[1].height).toBe(300);
  });

  test('"fit the page to each image" gives each page the image\'s own shape', async ({ page }) => {
    // A landscape photograph and a portrait one: if the page size were fixed,
    // one of them would be letterboxed and both pages would be the same size.
    await page.locator('#page-size').selectOption('fit');
    const wide = await realJpeg(page, 400, 200, 7);
    const tall = await realJpeg(page, 200, 400, 8);
    await load(page, [
      { name: 'wide.jpg', bytes: wide },
      { name: 'tall.jpg', bytes: tall },
    ]);

    const pages = readPages(await create(page));
    expect(pages).toHaveLength(2);

    const [first, second] = pages.map((p) => p.mediaBox!);
    expect(first[2]).toBeGreaterThan(first[3]); // landscape page
    expect(second[3]).toBeGreaterThan(second[2]); // portrait page
    expect(first).not.toEqual(second);
  });

  test('a fixed page size turns itself to suit each picture', async ({ page }) => {
    // A4 is A4 either way up. With orientation left on "auto" the page is
    // still A4 - 595 x 842 points - but a landscape picture gets it turned,
    // which is why the two pages here are the same size and not the same
    // shape. Asserting they were identical would have been asserting that
    // this feature does not exist.
    await page.locator('#page-size').selectOption('a4');
    await load(page, [
      { name: 'wide.jpg', bytes: await realJpeg(page, 400, 200, 9) },
      { name: 'tall.jpg', bytes: await realJpeg(page, 200, 400, 10) },
    ]);

    const pages = readPages(await create(page));
    expect(pages).toHaveLength(2);

    const a4 = (box: number[]) => [Math.round(box[2]), Math.round(box[3])].sort((x, y) => x - y);
    expect(a4(pages[0].mediaBox!)).toEqual(a4(pages[1].mediaBox!));

    // 210 x 297 mm is 595 x 842 points to the nearest point.
    const [shortest, longest] = a4(pages[0].mediaBox!);
    expect(shortest).toBeGreaterThanOrEqual(594);
    expect(shortest).toBeLessThanOrEqual(596);
    expect(longest).toBeGreaterThanOrEqual(841);
    expect(longest).toBeLessThanOrEqual(843);

    // The landscape picture got the landscape page, and the portrait one did not.
    expect(pages[0].mediaBox![2]).toBeGreaterThan(pages[0].mediaBox![3]);
    expect(pages[1].mediaBox![3]).toBeGreaterThan(pages[1].mediaBox![2]);
  });

  test('forcing portrait overrides what the picture would have chosen', async ({ page }) => {
    await page.locator('#page-size').selectOption('a4');
    await page.locator('#orientation').selectOption('portrait');
    await load(page, [
      { name: 'wide.jpg', bytes: await realJpeg(page, 400, 200, 13) },
      { name: 'tall.jpg', bytes: await realJpeg(page, 200, 400, 14) },
    ]);

    const pages = readPages(await create(page));
    expect(pages).toHaveLength(2);
    // Told explicitly, both pages are portrait - including the one holding a
    // landscape photograph.
    expect(pages[0].mediaBox).toEqual(pages[1].mediaBox);
    expect(pages[0].mediaBox![3]).toBeGreaterThan(pages[0].mediaBox![2]);
  });
});

test.describe('images-to-pdf: the list and the promise', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('removing everything empties the list and disables the button', async ({ page }) => {
    await load(page, [{ name: 'a.jpg', bytes: await realJpeg(page, 120, 120, 11) }]);

    await page.locator('#clear-all').click();
    await expect(page.locator('#image-list li')).toHaveCount(0);
    await expect(page.locator('#export')).toBeDisabled();
  });

  test('the pictures never leave the page', async ({ page }) => {
    const traffic: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.url().length > 500) {
        traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 4000)}`);
      }
    });

    await load(page, [{ name: 'private.jpg', bytes: await realJpeg(page, 200, 200, 12) }]);
    await create(page);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'image or document data was sent')
        .not.toMatch(/image\/jpeg|application\/pdf|%PDF|\/9j\//);
    }
  });
});
