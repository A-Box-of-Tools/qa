import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { encodePng, type Rgb } from '../../lib/image-fixtures';
import { readPages } from '../../lib/pdf';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the Document Scanner.
 *
 * It takes a photograph of a page, finds the four corners, undoes the
 * perspective, divides out the uneven light, and writes the result into a PDF.
 * Several photographs become the pages of one document.
 *
 * The corner-finding is the part that cannot be usefully asserted from here.
 * Whether it picked the right four points on a real photograph is a question
 * about a detector, and the honest answer needs photographs, not a fixture -
 * so what is checked instead is everything a wrong answer there would still
 * have to satisfy, plus the things a reader can see: that every photograph
 * becomes exactly one page, that the sheet is the size that was asked for,
 * that "use the whole photo" gives a predictable result, and that the file is
 * a PDF something else can open.
 *
 * The fixture is a pale page on a dark background with black marks on it -
 * the shape the detector is looking for, so it has something to find rather
 * than a flat colour with no edges at all.
 */

const URL_PATH = '/document-scanner/';

const WHITE: Rgb = [244, 242, 236];
const DARK: Rgb = [24, 26, 30];
const INK: Rgb = [20, 20, 20];

/**
 * A photograph of a page: a light rectangle on a dark surface, inset from the
 * edges, with a few lines of "text" on it.
 */
function photoOfAPage(width = 900, height = 1200, inset = 60): Buffer {
  return encodePng(width, height, (x, y) => {
    const onPage = x > inset && x < width - inset && y > inset && y < height - inset;
    if (!onPage) return DARK;

    // A handful of dark bars, so the page is not a blank field.
    const row = Math.floor((y - inset) / 90);
    const inBar = (y - inset) % 90 < 26 && row > 0 && row < 11
      && x > inset + 40 && x < width - inset - 40;
    return inBar ? INK : WHITE;
  });
}

async function load(page: Page, count: number): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles(
    Array.from({ length: count }, (_, index) => ({
      name: `photo-${index}.png`,
      mimeType: 'image/png',
      buffer: photoOfAPage(),
    })),
  );
  await expect(page.locator('#page-strip li')).toHaveCount(count, { timeout: 60_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Save as PDF and return what the browser saved. */
async function savePdf(page: Page): Promise<Buffer> {
  await expect(page.locator('#save-pdf')).toBeEnabled({ timeout: 60_000 });
  await page.locator('#save-pdf').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 120_000 });

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('document-scanner: photographs into a document', () => {
  test('control: the fixture looks like a page on a table', async ({ page }) => {
    // If the fixture were a flat colour the detector would have nothing to
    // find, and every result below would be about the fallback rather than
    // about the tool.
    const bytes = photoOfAPage();
    expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');

    await load(page, 1);
    await expect(page.locator('#edit-controls')).toBeVisible({ timeout: 60_000 });
  });

  test('one photograph becomes a one-page PDF', async ({ page }) => {
    test.setTimeout(240_000);
    await load(page, 1);

    const pdf = await savePdf(page);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(readPages(pdf)).toHaveLength(1);
  });

  test('three photographs become the three pages of one document', async ({ page }) => {
    // The reason this is a scanner and not a cropper: a stack of photographs
    // is one document, in the order they were given.
    test.setTimeout(300_000);
    await load(page, 3);

    const pdf = await savePdf(page);
    expect(readPages(pdf), 'a photograph did not become a page').toHaveLength(3);
  });

  test('a fixed sheet size is the size on every page', async ({ page }) => {
    // A4 is 210 x 297 mm, which is 595 x 842 points. Every page has to be it,
    // whatever shape the photograph was.
    test.setTimeout(300_000);
    await load(page, 2);
    await page.locator('#page-size').selectOption('a4');

    const pages = readPages(await savePdf(page));
    expect(pages).toHaveLength(2);

    for (const [index, item] of pages.entries()) {
      const box = item.mediaBox!;
      const sides = [Math.round(box[2]), Math.round(box[3])].sort((a, b) => a - b);
      expect(sides[0], `page ${index} is not A4`).toBeGreaterThanOrEqual(594);
      expect(sides[0]).toBeLessThanOrEqual(596);
      expect(sides[1]).toBeGreaterThanOrEqual(841);
      expect(sides[1]).toBeLessThanOrEqual(843);
    }
    expect(pages[0].mediaBox).toEqual(pages[1].mediaBox);
  });

  test('"fit the sheet to the page" does not give every page A4 anyway', async ({ page }) => {
    // The two settings have to differ, or the choice is decoration.
    test.setTimeout(300_000);
    await load(page, 1);

    await page.locator('#page-size').selectOption('fit');
    const fitted = readPages(await savePdf(page))[0].mediaBox!;

    await load(page, 1);
    await page.locator('#page-size').selectOption('a4');
    const a4 = readPages(await savePdf(page))[0].mediaBox!;

    expect(fitted, 'fit and A4 produced the same sheet').not.toEqual(a4);
  });

  test('taking the pages off the strip empties it', async ({ page }) => {
    test.setTimeout(120_000);
    await load(page, 2);

    await page.locator('#clear-all').click();
    await expect(page.locator('#page-strip li')).toHaveCount(0);
    await expect(page.locator('#save-pdf')).toBeDisabled();
  });

  test('"use the whole photo" is available and changes the result', async ({ page }) => {
    // The way out when the detector guesses wrong, which is the setting a
    // reader reaches for when the corners are not where they should be.
    test.setTimeout(300_000);
    await load(page, 1);
    await page.locator('#page-size').selectOption('fit');
    const detected = readPages(await savePdf(page))[0].mediaBox!;

    await load(page, 1);
    await page.locator('#page-size').selectOption('fit');
    await page.locator('#whole-photo').click();
    const whole = readPages(await savePdf(page))[0].mediaBox!;

    // Using the whole photograph keeps the dark border, so the sheet is a
    // different shape from the page that was cut out of it.
    expect(whole, 'taking the whole photo changed nothing').not.toEqual(detected);
  });
});

test.describe('document-scanner: the promise', () => {
  test('the photographs never leave the page', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const photo = photoOfAPage();
    await page.locator('#file-input').setInputFiles([{
      name: 'private.png', mimeType: 'image/png', buffer: photo,
    }]);
    await expect(page.locator('#page-strip li')).toHaveCount(1, { timeout: 60_000 });
    await savePdf(page);
    await quiet(page);

    const marker = photo.toString('base64').slice(200, 280);
    for (const entry of traffic) {
      expect(entry, 'the photograph was sent').not.toContain(marker);
      expect(entry, 'the document was sent').not.toContain('%PDF');
    }
  });
});
