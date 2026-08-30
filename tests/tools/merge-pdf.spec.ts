import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { buildPdf, readPages, allText, type FixturePage } from '../../lib/pdf';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the PDF Merger & Splitter.
 *
 * Its README is blunt about what the naive version of this tool gets wrong:
 * a page inherits its size, crop, rotation and resources from nodes above it
 * in the page tree, so copying the leaf on its own produces a file that
 * "opens" and is wrong - "every reader falls back to US Letter, and no
 * /Resources, so the fonts and images it draws with are gone".
 *
 * That is the shape of failure worth testing, because the output opens either
 * way. So the fixtures here deliberately use page sizes that are *not* US
 * Letter: if inheritance were dropped, the merged pages would come back
 * 612 x 792 and these tests would say so.
 *
 * Verification does not go through the tool. lib/pdf.ts resolves the xref,
 * unpacks the object streams the merger writes into, and walks the page tree
 * itself - grepping the output would find nothing, since its objects are
 * Flate-compressed inside object streams.
 */

const URL_PATH = '/merge-pdf/';

// Nothing here is 612 x 792, so a lost /MediaBox is visible rather than
// plausible.
const FIRST: FixturePage[] = [
  { label: 'one-a', width: 200, height: 100 },
  { label: 'one-b', width: 220, height: 140 },
];
const SECOND: FixturePage[] = [
  { label: 'two-a', width: 300, height: 400 },
  { label: 'two-b', width: 320, height: 420 },
  { label: 'two-c', width: 340, height: 440 },
];

const US_LETTER = [0, 0, 612, 792];

/** Put one or more PDFs on the list and wait for their pages to be counted. */
async function load(page: Page, documents: Array<{ name: string; pages: FixturePage[] }>): Promise<void> {
  await page.locator('#file-input').setInputFiles(documents.map((doc) => ({
    name: doc.name,
    mimeType: 'application/pdf',
    buffer: buildPdf(doc.pages),
  })));

  const total = documents.reduce((sum, doc) => sum + doc.pages.length, 0);
  await expect(page.locator('#pages-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#page-list li')).toHaveCount(total, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Build the document and return the bytes the browser saved. */
async function build(page: Page): Promise<Buffer> {
  await expect(page.locator('#run')).toBeEnabled();
  const pending = page.waitForEvent('download');
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30_000 });
  await page.locator('#download').click();

  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('merge-pdf: merging', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('control: the fixtures are readable and are not US Letter', async ({ page }) => {
    // If the fixtures were malformed, or happened to be Letter-sized, then
    // every assertion below about inheritance would pass for the wrong
    // reason. This is the check that they cannot.
    const pdf = buildPdf(FIRST);
    expect(readPages(pdf).map((p) => p.mediaBox)).toEqual([
      [0, 0, 200, 100],
      [0, 0, 220, 140],
    ]);
    expect(readPages(pdf).every((p) => JSON.stringify(p.mediaBox) !== JSON.stringify(US_LETTER)))
      .toBe(true);

    await load(page, [{ name: 'one.pdf', pages: FIRST }]);
    await expect(page.locator('#page-list li')).toHaveCount(2);
  });

  test('two documents become one, with every page and in order', async ({ page }) => {
    await load(page, [
      { name: 'one.pdf', pages: FIRST },
      { name: 'two.pdf', pages: SECOND },
    ]);

    const merged = await build(page);
    const pages = readPages(merged);

    expect(pages).toHaveLength(FIRST.length + SECOND.length);
    expect(allText(merged)).toEqual([
      'one-a', 'one-b', 'two-a', 'two-b', 'two-c',
    ]);
  });

  test('every merged page keeps its own size', async ({ page }) => {
    // The failure the README describes: the copies land under a new, flat
    // parent that cannot carry anybody's inherited attributes, so each page's
    // /MediaBox has to be written onto it explicitly. Dropped, these would
    // all come back as US Letter.
    await load(page, [
      { name: 'one.pdf', pages: FIRST },
      { name: 'two.pdf', pages: SECOND },
    ]);

    const pages = readPages(await build(page));
    const expected = [...FIRST, ...SECOND].map((p) => [0, 0, p.width, p.height]);

    expect(pages.map((p) => p.mediaBox)).toEqual(expected);
    expect(pages.some((p) => JSON.stringify(p.mediaBox) === JSON.stringify(US_LETTER)))
      .toBe(false);
  });

  test('the pages still draw what they drew before', async ({ page }) => {
    // A page whose /Resources were left behind still opens and still has a
    // content stream - it just cannot draw. Reading the text back proves the
    // stream came across; the font it names is in the same graph.
    await load(page, [{ name: 'one.pdf', pages: FIRST }]);

    const merged = await build(page);
    const pages = readPages(merged);

    expect(pages.map((p) => p.text)).toEqual([['one-a'], ['one-b']]);
    for (const page_ of pages) expect(page_.text.length).toBeGreaterThan(0);
  });

  test('one document on its own comes back unharmed', async ({ page }) => {
    await load(page, [{ name: 'only.pdf', pages: SECOND }]);

    const out = await build(page);
    expect(readPages(out)).toHaveLength(SECOND.length);
    expect(allText(out)).toEqual(['two-a', 'two-b', 'two-c']);
    expect(readPages(out).map((p) => p.mediaBox)).toEqual(
      SECOND.map((p) => [0, 0, p.width, p.height]),
    );
  });
});

test.describe('merge-pdf: choosing and ordering pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await load(page, [
      { name: 'one.pdf', pages: FIRST },
      { name: 'two.pdf', pages: SECOND },
    ]);
  });

  test('reversing turns the whole order round', async ({ page }) => {
    await page.locator('#reverse').click();

    expect(allText(await build(page))).toEqual([
      'two-c', 'two-b', 'two-a', 'one-b', 'one-a',
    ]);
  });

  test('a range can be kept, and the sizes follow the pages', async ({ page }) => {
    await page.locator('#range').fill('2-4');
    await page.locator('#range-keep').click();
    await expect(page.locator('#page-list li')).toHaveCount(3);

    const out = await build(page);
    expect(allText(out)).toEqual(['one-b', 'two-a', 'two-b']);
    // Each kept page keeps the size it had in its own document, which is the
    // inheritance check again on a subset.
    expect(readPages(out).map((p) => p.mediaBox)).toEqual([
      [0, 0, 220, 140],
      [0, 0, 300, 400],
      [0, 0, 320, 420],
    ]);
  });

  test('a range can be dropped', async ({ page }) => {
    await page.locator('#range').fill('1, 3');
    await page.locator('#range-drop').click();
    await expect(page.locator('#page-list li')).toHaveCount(3);

    expect(allText(await build(page))).toEqual(['one-b', 'two-b', 'two-c']);
  });

  test('an open-ended range runs to the end', async ({ page }) => {
    await page.locator('#range').fill('4-');
    await page.locator('#range-keep').click();
    await expect(page.locator('#page-list li')).toHaveCount(2);

    expect(allText(await build(page))).toEqual(['two-b', 'two-c']);
  });

  test('a range that means nothing is refused rather than guessed at', async ({ page }) => {
    await page.locator('#range').fill('not a range');
    await page.locator('#range-keep').click();

    await expect(page.locator('#range-error')).toBeVisible();
    // And nothing was removed on the strength of it.
    await expect(page.locator('#page-list li')).toHaveCount(5);
  });

  test('"back to how they came" undoes the shuffling', async ({ page }) => {
    await page.locator('#reverse').click();
    await page.locator('#range').fill('1-2');
    await page.locator('#range-drop').click();
    await expect(page.locator('#page-list li')).toHaveCount(3);

    await page.locator('#restore').click();
    await expect(page.locator('#page-list li')).toHaveCount(5);

    expect(allText(await build(page))).toEqual([
      'one-a', 'one-b', 'two-a', 'two-b', 'two-c',
    ]);
  });
});

test.describe('merge-pdf: the promise', () => {
  test('the documents never leave the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.url().length > 500) {
        traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 4000)}`);
      }
    });

    await load(page, [{ name: 'private.pdf', pages: FIRST }]);
    await build(page);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'document content was sent').not.toMatch(/one-a|%PDF|application\/pdf/);
    }
  });

  test('starting again empties the list', async ({ page }) => {
    await page.goto(URL_PATH);
    await load(page, [{ name: 'one.pdf', pages: FIRST }]);

    await page.locator('#clear-all').click();
    await expect(page.locator('#page-list li')).toHaveCount(0);
  });
});
