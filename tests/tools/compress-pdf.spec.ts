import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { realJpeg } from '../../lib/browser-jpeg';
import {
  allText, buildImagePdf, buildPdf, readImages, readPages, type FixturePage,
} from '../../lib/pdf';

/**
 * Tool-level functional tests for the PDF Compressor.
 *
 * Its README argues that "compress a PDF" is two jobs sharing one name, and
 * that "every service that offers it lets you find out which one you have by
 * waiting for the result". A scan is mostly image data and can lose 60-90%; a
 * contract is text and deflated fonts, where "there is no eighty per cent
 * hiding in it" and the honest answer is a few per cent. Which one you have is
 * measurable, and the tool measures it up front - "if this tool could keep
 * only one screen it would keep that one".
 *
 * So there are two things worth testing, and the second is the unusual one:
 *
 *   1. Compressing must not lose the document - same pages, same sizes, same
 *      text afterwards.
 *   2. The verdict must actually distinguish the two kinds of file, rather
 *      than promising the same thing about both. That is checked by handing it
 *      one of each and requiring the two verdicts to differ.
 */

const URL_PATH = '/compress-pdf/';

const TEXT_PAGES: FixturePage[] = [
  { label: 'contract-1', width: 400, height: 300 },
  { label: 'contract-2', width: 400, height: 300 },
  { label: 'contract-3', width: 420, height: 320 },
];

/** Put one PDF in and wait for the inventory to be worked out. */
async function load(page: Page, bytes: Buffer, name = 'document.pdf'): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  await expect(page.locator('#inventory-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#load-error')).toBeHidden();
  await expect(page.locator('#verdict')).not.toBeEmpty({ timeout: 30_000 });
}

/** Compress with the current settings and return the saved bytes. */
async function compress(page: Page): Promise<Buffer> {
  await expect(page.locator('#run')).toBeEnabled({ timeout: 20_000 });
  const pending = page.waitForEvent('download');
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });
  await page.locator('#download').click();

  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

/** A PDF made of photographs - the "stack of photographs in a wrapper" case. */
async function scanLike(page: Page, pages = 2): Promise<Buffer> {
  const images = [];
  for (let i = 0; i < pages; i += 1) {
    images.push({ jpeg: await realJpeg(page, 900, 640, i + 20), width: 900, height: 640 });
  }
  return buildImagePdf(images);
}

test.describe('compress-pdf: the document survives', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('a text document keeps every page, its size and its words', async ({ page }) => {
    // Compression that quietly dropped a page, or reset the page size, would
    // still hand back a smaller file that opens - which is the only thing
    // most people check.
    await load(page, buildPdf(TEXT_PAGES), 'contract.pdf');

    const out = await compress(page);
    const pages = readPages(out);

    expect(pages).toHaveLength(TEXT_PAGES.length);
    expect(allText(out)).toEqual(TEXT_PAGES.map((p) => p.label));
    expect(pages.map((p) => p.mediaBox)).toEqual(
      TEXT_PAGES.map((p) => [0, 0, p.width, p.height]),
    );
  });

  test('a scanned document keeps its pages and still has its pictures', async ({ page }) => {
    const original = await scanLike(page, 2);
    await load(page, original, 'scan.pdf');

    const out = await compress(page);

    expect(readPages(out)).toHaveLength(2);
    const images = readImages(out);
    expect(images.length, 'the pictures went missing').toBeGreaterThanOrEqual(2);
    for (const image of images) expect(image.data.length).toBeGreaterThan(0);
  });

  test('the picture is re-encoded smaller, which is where the saving comes from', async ({ page }) => {
    // The opposite of the EXIF remover's promise, and deliberately so: here
    // re-encoding the image is the whole job. What has to hold is that it
    // actually got smaller rather than merely being copied about.
    const original = await scanLike(page, 1);
    const before = readImages(original)[0];

    await load(page, original, 'scan.pdf');
    await page.locator('input[name="preset"][value="smallest"]').check();

    const out = await compress(page);
    const after = readImages(out)[0];

    expect(after.data.length, 'the image was not made smaller').toBeLessThan(before.data.length);
    expect(out.length).toBeLessThan(original.length);
  });

  test('a gentler preset gives away less than the smallest one', async ({ page }) => {
    // The presets are a scale, so they have to behave like one: less quality
    // spent must mean a bigger file, not the same file with a different label.
    // Two full compressions of a photographic PDF, so it needs more than the
    // default budget - the comparison is the test, and one half of it would
    // prove nothing.
    test.setTimeout(180_000);

    const original = await scanLike(page, 1);

    await load(page, original, 'scan.pdf');
    await page.locator('input[name="preset"][value="smallest"]').check();
    const smallest = await compress(page);

    await page.goto(URL_PATH);
    await load(page, original, 'scan.pdf');
    await page.locator('input[name="preset"][value="print"]').check();
    const print = await compress(page);

    expect(print.length).toBeGreaterThan(smallest.length);
  });
});

test.describe('compress-pdf: the measurement it leads with', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('the breakdown is shown before anything is compressed', async ({ page }) => {
    await load(page, buildPdf(TEXT_PAGES), 'contract.pdf');

    await expect(page.locator('#breakdown-list')).not.toBeEmpty();
    await expect(page.locator('#verdict')).not.toBeEmpty();
    // The inventory is step two; the result does not exist yet.
    await expect(page.locator('#result')).toBeHidden();
  });

  test('a text document and a scan are not told the same story', async ({ page }) => {
    // The claim the tool is proudest of. If both files got the same sentence,
    // the measurement would be decoration - and a reader with a contract would
    // be promised a saving that is not there.
    //
    // Two documents inspected in one test, one of them photographic, so this
    // needs its own budget for the same reason as the preset comparison.
    test.setTimeout(180_000);

    await load(page, buildPdf(TEXT_PAGES), 'contract.pdf');
    const textVerdict = ((await page.locator('#verdict').textContent()) ?? '').trim();

    await page.goto(URL_PATH);
    await load(page, await scanLike(page, 2), 'scan.pdf');
    const scanVerdict = ((await page.locator('#verdict').textContent()) ?? '').trim();

    expect(textVerdict.length).toBeGreaterThan(0);
    expect(scanVerdict.length).toBeGreaterThan(0);
    expect(scanVerdict, 'the same verdict was given for a contract and a scan')
      .not.toBe(textVerdict);
  });

  test('the breakdown of a scan is mostly pictures', async ({ page }) => {
    await load(page, await scanLike(page, 2), 'scan.pdf');
    await expect(page.locator('#breakdown-list')).toContainText(/image|picture/i);
  });
});

test.describe('compress-pdf: the promise', () => {
  test('the document never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.url().length > 500) {
        traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 4000)}`);
      }
    });

    await load(page, buildPdf(TEXT_PAGES), 'private.pdf');
    await compress(page);
    await page.waitForLoadState('networkidle');

    for (const entry of traffic) {
      expect(entry, 'document content was sent')
        .not.toMatch(/contract-1|%PDF|application\/pdf/);
    }
  });

  test('choosing another file clears the last result', async ({ page }) => {
    await page.goto(URL_PATH);
    await load(page, buildPdf(TEXT_PAGES), 'first.pdf');
    await compress(page);
    await expect(page.locator('#result')).toBeVisible();

    await page.locator('#clear-file').click();
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#inventory-card')).toBeHidden();
  });
});
