import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { realJpeg } from '../../lib/browser-jpeg';
import { decodedSize } from '../../lib/browser-image';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the Image Resizer.
 *
 * The most-used shape of tool on the site, and the one where a wrong answer is
 * least likely to be questioned: a picture that comes back at nearly the right
 * size looks fine, and the number only matters later, when something rejects
 * it for being 1919 pixels wide.
 *
 * So every test here reads the size back out of the file the browser saved,
 * rather than off the page. The cases are the ones where an off-by-one or a
 * rounding choice hides: an odd-numbered source, a percentage that does not
 * divide, a long edge applied to the wrong side, and the "never enlarge" rule
 * that has to bind in one direction and not the other.
 */

const URL_PATH = '/resize-image/';

/** Deliberately odd numbers: rounding bugs hide behind 800 x 600. */
const SOURCE_WIDTH = 1001;
const SOURCE_HEIGHT = 667;

async function load(
  page: Page,
  images: Array<{ name: string; bytes: Buffer }>,
): Promise<void> {
  await page.locator('#file-input').setInputFiles(images.map((image) => ({
    name: image.name,
    mimeType: 'image/jpeg',
    buffer: image.bytes,
  })));
  await expect(page.locator('#file-list li')).toHaveCount(images.length, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** One source image, at the odd size above. */
async function source(page: Page, seed = 1): Promise<Buffer> {
  return realJpeg(page, SOURCE_WIDTH, SOURCE_HEIGHT, seed);
}

/** Run the resize and return every file the page offers. */
async function run(page: Page): Promise<Buffer[]> {
  await expect(page.locator('#run')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#run').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 60_000 });

  const links = page.locator('#results a[download]');
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

test.describe('resize-image: the size that comes out', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('a width with the height left blank keeps the shape', async ({ page }) => {
    // 1001 x 667 to 500 wide is 333.16... tall. Whichever way that is rounded,
    // it must not be 334 and must not silently become 1001's aspect ratio
    // rounded twice.
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('pixels');
    await page.locator('#size-w').fill('500');
    await page.locator('#size-h').fill('');

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width).toBe(500);
    expect(size.height).toBe(Math.round((SOURCE_HEIGHT * 500) / SOURCE_WIDTH));
  });

  test('a percentage is a percentage of the real size', async ({ page }) => {
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('percent');
    await page.locator('#size-percent').fill('50');

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    // 1001 and 667 both halve to a fraction, so this is the rounding case.
    expect(size.width).toBe(Math.round(SOURCE_WIDTH / 2));
    expect(size.height).toBe(Math.round(SOURCE_HEIGHT / 2));
  });

  test('the longest side lands on the longest side', async ({ page }) => {
    // Landscape here, so the long edge is the width; a tool that always sets
    // the width passes this and fails the portrait case below.
    await load(page, [{ name: 'wide.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('longest');
    await page.locator('#size-longest').fill('800');

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width).toBe(800);
    expect(size.height).toBeLessThan(800);
  });

  test('the longest side of a portrait picture is its height', async ({ page }) => {
    await load(page, [{ name: 'tall.jpg', bytes: await realJpeg(page, 400, 900, 4) }]);
    await page.locator('#resize-mode').selectOption('longest');
    await page.locator('#size-longest').fill('600');

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.height).toBe(600);
    expect(size.width).toBeLessThan(600);
  });

  test('"never enlarge" leaves a smaller picture alone', async ({ page }) => {
    // Asking for 4000 from a 1001-wide source with the rule on must not
    // upscale - there is nothing to upscale with, and a bigger file that is no
    // sharper is worse than the original in every way.
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('pixels');
    await page.locator('#size-w').fill('4000');
    await page.locator('#size-h').fill('');
    await expect(page.locator('#no-enlarge')).toBeChecked();

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width).toBe(SOURCE_WIDTH);
    expect(size.height).toBe(SOURCE_HEIGHT);
  });

  test('turning "never enlarge" off does enlarge', async ({ page }) => {
    // The rule has to bind in one direction only; if it were ignored either
    // way the checkbox would be decoration.
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('pixels');
    await page.locator('#size-w').fill('1500');
    await page.locator('#size-h').fill('');
    await page.locator('#no-enlarge').uncheck();

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width).toBe(1500);
  });

  test('"fill it" gives exactly the box, cutting the overflow off', async ({ page }) => {
    // contain and cover differ precisely here: cover must be the box exactly,
    // where contain would come out short on one side.
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('pixels');
    await page.locator('#size-w').fill('400');
    await page.locator('#size-h').fill('400');
    await page.locator('#fit').selectOption('cover');

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width).toBe(400);
    expect(size.height).toBe(400);
  });

  test('"fit inside" comes out short on one side rather than distorting', async ({ page }) => {
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('pixels');
    await page.locator('#size-w').fill('400');
    await page.locator('#size-h').fill('400');
    await page.locator('#fit').selectOption('contain');

    const [out] = await run(page);
    const size = await decodedSize(page, out, 'image/jpeg');

    expect(size.width).toBe(400);
    expect(size.height).toBeLessThan(400);
    // The shape is preserved, which is the whole point of fitting inside.
    expect(size.height).toBe(Math.round((SOURCE_HEIGHT * 400) / SOURCE_WIDTH));
  });
});

test.describe('resize-image: formats and batches', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('converting to PNG produces a PNG at the right size', async ({ page }) => {
    await load(page, [{ name: 'photo.jpg', bytes: await source(page) }]);
    await page.locator('#resize-mode').selectOption('pixels');
    await page.locator('#size-w').fill('320');
    await page.locator('#size-h').fill('');
    await page.locator('#format').selectOption('image/png');

    const [out] = await run(page);
    expect(out.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect((await decodedSize(page, out, 'image/png')).width).toBe(320);
  });

  test('every image in a batch gets the same treatment', async ({ page }) => {
    test.setTimeout(120_000);

    await load(page, [
      { name: 'one.jpg', bytes: await realJpeg(page, 800, 400, 5) },
      { name: 'two.jpg', bytes: await realJpeg(page, 300, 900, 6) },
      { name: 'three.jpg', bytes: await realJpeg(page, 640, 640, 7) },
    ]);
    await page.locator('#resize-mode').selectOption('longest');
    await page.locator('#size-longest').fill('200');

    const files = await run(page);
    expect(files.length).toBeGreaterThanOrEqual(3);

    for (const [index, file] of files.slice(0, 3).entries()) {
      const size = await decodedSize(page, file, 'image/jpeg');
      expect(Math.max(size.width, size.height), `image ${index} was not resized`).toBe(200);
    }
  });

  test('the pictures never leave the page', async ({ page }) => {
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = await source(page);
    await load(page, [{ name: 'private.jpg', bytes }]);
    await page.locator('#resize-mode').selectOption('percent');
    await page.locator('#size-percent').fill('25');
    await run(page);
    await quiet(page);

    // Looked for by a distinctive slice of the file's own bytes rather than by
    // words like "jpeg" or "base64": the analytics tag legitimately reports the
    // address and title of the page being viewed, and a pattern that broad
    // flags the tool's own name while saying nothing about the file.
    const marker = bytes.toString('base64').slice(400, 480);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});
