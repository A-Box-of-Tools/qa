import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { allText, buildPdf, readPages, type FixturePage } from '../../lib/pdf';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the PDF Redactor.
 *
 * The same failure as the image redactor, in the format where it has done the
 * most damage. Its README is blunt about it: in almost every program that
 * offers to redact a page the rectangle is an object saved beside the text
 * rather than into it, so selecting the area and pressing copy hands the words
 * back - a failure that "has published court filings, intelligence reports,
 * and, in December 2025, blacked-out names in a mass release of Department of
 * Justice documents that were readable within hours of publication."
 *
 * So the only test that means anything is to read the text back out of the
 * finished file. lib/pdf.ts does that without going near the tool: it resolves
 * the xref, unpacks the object streams and pulls the strings out of each
 * page's content stream. A rectangle drawn over a word changes nothing it can
 * see, which is exactly the point.
 */

const URL_PATH = '/redact-pdf/';

const SECRET = 'Wolfsbane';
const OTHER_SECRET = 'Ravenglass';
const KEEP = 'Ordinary';

/** A document with a word worth removing and words that must survive. */
const PAGES: FixturePage[] = [
  { label: `${KEEP} one ${SECRET} here`, width: 400, height: 300 },
  { label: `${KEEP} two ${OTHER_SECRET} here`, width: 400, height: 300 },
  { label: `${KEEP} three nothing to hide`, width: 400, height: 300 },
];

async function load(page: Page, pages = PAGES, name = 'filing.pdf'): Promise<Buffer> {
  const bytes = buildPdf(pages);
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({
    name, mimeType: 'application/pdf', buffer: bytes,
  });
  await expect(page.locator('#doc-facts')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#load-error')).toBeHidden();
  return bytes;
}

/** Search for a term and tick every match. */
async function findAndTick(page: Page, term: string): Promise<number> {
  await page.locator('#terms').fill(term);
  await page.locator('#find').click();
  await expect(page.locator('#match-bar')).toBeVisible({ timeout: 30_000 });
  await page.locator('#tick-all').click();
  const count = await page.locator('#match-list li').count();
  return count;
}

/** Take them out and return the file the browser saved. */
async function redact(page: Page): Promise<Buffer> {
  await expect(page.locator('#run')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('redact-pdf: the words are gone', () => {
  test('control: the fixture really does contain the words', async ({ page }) => {
    // Without this, "the word is not in the output" would pass just as well
    // for a fixture that never had it, or one whose text this reader cannot
    // see at all.
    const bytes = buildPdf(PAGES);
    const text = allText(bytes).join(' ');

    expect(text).toContain(SECRET);
    expect(text).toContain(OTHER_SECRET);
    expect(text).toContain(KEEP);

    await load(page);
    await expect(page.locator('#doc-sub')).toContainText('3');
  });

  test('a redacted word cannot be read out of the finished file', async ({ page }) => {
    // The whole tool. A black rectangle would leave this text exactly where it
    // was, and the file would look right in every reader.
    test.setTimeout(180_000);
    await load(page);

    const found = await findAndTick(page, SECRET);
    expect(found, 'the word was not found to begin with').toBeGreaterThan(0);

    const out = await redact(page);
    const text = allText(out).join(' ');

    expect(text, 'the redacted word is still in the text').not.toContain(SECRET);
    // And not merely hidden from the text extractor: not in the bytes either.
    expect(out.includes(Buffer.from(SECRET, 'latin1')), 'the word is still in the file')
      .toBe(false);
  });

  test('everything that was not ticked is still there', async ({ page }) => {
    // A redactor that removed the page, or the whole line, would pass the test
    // above and be useless.
    test.setTimeout(180_000);
    await load(page);
    await findAndTick(page, SECRET);

    const out = await redact(page);
    const text = allText(out).join(' ');

    expect(text, 'the surrounding words were taken out too').toContain(KEEP);
    expect(text, 'a word nobody ticked was removed').toContain(OTHER_SECRET);
    expect(readPages(out), 'a page went missing').toHaveLength(PAGES.length);
  });

  test('two terms both go, and the pages keep their size', async ({ page }) => {
    test.setTimeout(180_000);
    await load(page);

    await page.locator('#terms').fill(`${SECRET}\n${OTHER_SECRET}`);
    await page.locator('#find').click();
    await expect(page.locator('#match-bar')).toBeVisible({ timeout: 30_000 });
    await page.locator('#tick-all').click();

    const out = await redact(page);
    const text = allText(out).join(' ');

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OTHER_SECRET);
    expect(text).toContain(KEEP);

    expect(readPages(out).map((p) => p.mediaBox)).toEqual(
      PAGES.map((p) => [0, 0, p.width, p.height]),
    );
  });

  test('matching is case-insensitive unless it is told otherwise', async ({ page }) => {
    // A redactor that missed WOLFSBANE because somebody typed Wolfsbane is a
    // redactor that leaves the name in the document.
    test.setTimeout(180_000);
    await load(page, [
      { label: `Upper ${SECRET.toUpperCase()} here`, width: 400, height: 300 },
    ]);

    const found = await findAndTick(page, SECRET.toLowerCase());
    expect(found, 'a differently-cased match was not found').toBeGreaterThan(0);

    const out = await redact(page);
    expect(allText(out).join(' ')).not.toContain(SECRET.toUpperCase());
  });

  test('a term that is not in the document finds nothing', async ({ page }) => {
    test.setTimeout(120_000);
    await load(page);

    await page.locator('#terms').fill('Nonexistentium');
    await page.locator('#find').click();

    // Either the bar stays away or it says none - what must not happen is a
    // match being invented.
    await expect(page.locator('#match-list li')).toHaveCount(0, { timeout: 30_000 });
  });
});

test.describe('redact-pdf: the promise', () => {
  test('the document never leaves the page', async ({ page }) => {
    // A tool people bring court filings to.
    test.setTimeout(180_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await load(page, PAGES, 'private.pdf');
    await findAndTick(page, SECRET);
    await redact(page);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the secret word was sent').not.toContain(SECRET);
      expect(entry, 'the document was sent').not.toContain('%PDF');
    }
  });
});
