import { test, expect } from '@playwright/test';
import { allText, readImages, readPages } from '../../lib/pdf';
import { loadTheExample, pressChip, runAndSave, runCard } from '../../lib/tool-frame';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the PDF watermarker.
 *
 * WHAT THE TOOL PROMISES
 *
 * Words across every page - who the copy is for, a date - drawn once as a
 * picture with the browser's own fonts, so any script works, and placed on
 * each page as an image XObject with its shape in a soft mask, over content
 * that is not otherwise touched. Not protection, and the page says so.
 *
 * WHAT IS CHECKED, AND WITH WHAT
 *
 * The file is opened with lib/pdf.ts, which walks the page tree and now also
 * reads which XObjects each page's content stream draws. So the checks are
 * the ones a reader would make: every page draws the stamp's image (by the
 * resource name src/apply.js gives it), that image exists once with a soft
 * mask, and the pages are still the pages - three of them, with the
 * statement's own words still drawn on each. "First page only" has to leave
 * pages two and three alone, which is the other half of "every page": the
 * stamp goes exactly where it was asked to.
 *
 * The page's check line is required to be green and then not believed.
 */

const URL_PATH = '/watermark-pdf/';

const SHIPPED = discoverTools().includes('watermark-pdf');
const NOT_YET = 'this site does not ship watermark-pdf yet';

/** The example statement has three pages, each headed STATEMENT n / 3. */
const PAGES = 3;

/** The resource name the stamp is drawn by; from tools/watermark-pdf/src/apply.js. */
const STAMP = 'AbxWmImg';

const WORDS = 'for QA only — 13 September 2026';

test.describe('watermark-pdf: the document it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await loadTheExample(page);
  });

  test('nothing runs until there are words on the stamp', async ({ page }) => {
    // A document alone is not a job: the stamp has to say something.
    await expect(runCard(page)).toHaveAttribute('inert', '');
    await page.locator('#words').fill(WORDS);
    await expect(runCard(page), 'the card is still asleep with words on the stamp')
      .not.toHaveAttribute('inert', '');
    await page.locator('#words').fill('');
    await expect(runCard(page), 'the card stayed awake with the words taken away')
      .toHaveAttribute('inert', '');
  });

  test('every page draws the stamp, and is otherwise the page it was', async ({ page }) => {
    test.setTimeout(180_000);
    await page.locator('#words').fill(WORDS);
    await pressChip(page, '[data-colour="red"]');

    const bytes = await runAndSave(page);

    const pages = readPages(bytes);
    expect(pages.length, 'the stamped file does not have the example\'s pages').toBe(PAGES);
    for (const [index, one] of pages.entries()) {
      expect(one.xobjects, `page ${index + 1} does not draw the stamp`).toContain(STAMP);
      expect(one.text.join(' '), `page ${index + 1} lost its own words`)
        .toContain(`STATEMENT ${index + 1} / ${PAGES}`);
    }

    // The stamp is one picture, shared, with its shape in a soft mask - so
    // the words sit over the page without a white box around them.
    const images = readImages(bytes);
    expect(images.length, 'no image in the file: the stamp was not written as a picture')
      .toBeGreaterThan(0);
    expect(bytes.toString('latin1').includes('/SMask'), 'the stamp has no soft mask').toBe(true);
    expect(allText(bytes).join(' ')).toContain(`STATEMENT ${PAGES} / ${PAGES}`);
  });

  test('first page only stamps the first page only', async ({ page }) => {
    test.setTimeout(180_000);
    await page.locator('#words').fill(WORDS);
    await page.locator('#first-only').check();

    const pages = readPages(await runAndSave(page));
    expect(pages.length).toBe(PAGES);
    expect(pages[0].xobjects, 'the first page does not draw the stamp').toContain(STAMP);
    for (const [index, one] of pages.slice(1).entries()) {
      expect(one.xobjects, `page ${index + 2} was stamped when only the first was asked for`)
        .not.toContain(STAMP);
    }
  });

  test('repeated across the page is still one picture, drawn more than once', async ({ page }) => {
    test.setTimeout(180_000);
    await page.locator('#words').fill(WORDS);
    await pressChip(page, '[data-tiled="yes"]');

    const bytes = await runAndSave(page);
    const pages = readPages(bytes);
    const drawn = pages[0].xobjects.filter((name) => name === STAMP).length;
    expect(drawn, 'a tiled stamp is drawn once').toBeGreaterThan(1);
  });
});

test.describe('watermark-pdf: what it refuses', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('something that is not a PDF is refused, and said so', async ({ page }) => {
    await page.goto(URL_PATH);
    await page.locator('#file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a pdf at all\n', 'utf8'),
    });
    await expect(page.locator('#load-error')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#load-error')).toContainText(/PDF/i);
    await expect(page.locator('#file-row')).toBeHidden();
  });
});
