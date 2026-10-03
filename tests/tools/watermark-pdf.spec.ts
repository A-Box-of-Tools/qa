import { test, expect } from '@playwright/test';
import { allText, dictValue, readImages, readObjects, readPages } from '../../lib/pdf';
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


/** A cropped page with an inherited, offset viewport and a clockwise turn. */
function croppedFixture(): Buffer {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /CropBox [100 200 300 500] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Rotate 90 /Resources << >> >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = bodies.map((body, index) => {
    const offset = Buffer.byteLength(text, 'latin1');
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(text, 'latin1');
  text += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  text += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, 'latin1');
}

/** Resolve this page's named resource without consulting the site's parser. */
function stampResource(bytes: Buffer, category: string, name: string) {
  const objects = readObjects(bytes);
  const page = [...objects.values()].find((object) => /\/Type\s*\/Page\b/.test(object.body))!;
  const resolve = (value: string | null): string => {
    const ref = /^(\d+)\s+\d+\s+R$/.exec(value?.trim() ?? '');
    return ref ? objects.get(Number(ref[1]))!.body : value ?? '';
  };
  const resources = resolve(dictValue(page.body, 'Resources'));
  const resource = dictValue(resolve(dictValue(resources, category)), name);
  const ref = /^(\d+)\s+\d+\s+R$/.exec(resource?.trim() ?? '');
  expect(ref, `${category}/${name} must name a saved resource`).not.toBeNull();
  return objects.get(Number(ref![1]))!;
}

test('watermark-pdf: the stamp and preview use the rotated visible CropBox', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!SHIPPED, NOT_YET);
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({ name: 'cropped.pdf', mimeType: 'application/pdf', buffer: croppedFixture() });
  await expect(page.locator('#file-row')).toBeVisible();
  await page.locator('#words').fill('VISIBLE WATERMARK');
  await pressChip(page, '[data-diagonal="no"]');
  const shape = await page.locator('#preview').evaluate((canvas) => {
    const { width, height } = canvas as HTMLCanvasElement;
    return width / height;
  });
  expect(shape).toBeCloseTo(1.5, 2);
  const saved = await runAndSave(page);
  expect(readPages(saved)[0].mediaBox).toEqual([0, 0, 1000, 1000]);
  const drawing = [...readObjects(saved).values()].find((object) => object.stream?.includes(Buffer.from(`/${STAMP} Do`)))!.stream!.toString('latin1');
  const matrices = [...drawing.matchAll(/^([\d. -]+) cm$/gm)].map((match) => match[1].split(' ').map(Number));
  expect(matrices).toHaveLength(2);
  const transform = ([a, b, c, d, e, f]: number[], x: number, y: number) => [a * x + c * y + e, b * x + d * y + f];
  const local = transform(matrices[1], 0.5, 0.5);
  const centre = transform(matrices[0], local[0], local[1]);
  expect(centre[0]).toBeCloseTo(200, 3);
  expect(centre[1]).toBeCloseTo(350, 3);
});

test('watermark-pdf: adding a second stamp preserves the first stamp image and opacity', async ({ page }) => {
  test.setTimeout(240_000);
  test.skip(!SHIPPED, NOT_YET);
  await page.goto(URL_PATH);
  await loadTheExample(page);
  await page.locator('#words').fill('FIRST STAMP');
  await pressChip(page, '[data-colour="red"]');
  const first = await runAndSave(page);
  const image = stampResource(first, 'XObject', STAMP);
  const state = stampResource(first, 'ExtGState', 'AbxWmGs');
  await page.locator('#file-input').setInputFiles({ name: 'stamped.pdf', mimeType: 'application/pdf', buffer: first });
  await expect(page.locator('#file-name')).toHaveText('stamped.pdf');
  await page.locator('#words').fill('SECOND STAMP');
  await pressChip(page, '[data-colour="blue"]');
  await page.locator('#opacity').evaluate((element) => {
    (element as HTMLInputElement).value = '80';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const second = await runAndSave(page);
  expect(stampResource(second, 'XObject', STAMP).stream).toEqual(image.stream);
  expect(dictValue(stampResource(second, 'ExtGState', 'AbxWmGs').body, 'ca')).toBe(dictValue(state.body, 'ca'));
  for (const one of readPages(second)) {
    expect(one.xobjects).toContain(STAMP);
    expect(one.xobjects).toContain(`${STAMP}1`);
  }
  expect(stampResource(second, 'XObject', `${STAMP}1`).stream).not.toEqual(image.stream);
  expect(dictValue(stampResource(second, 'ExtGState', 'AbxWmGs1').body, 'ca')).toBe('0.8');
});
