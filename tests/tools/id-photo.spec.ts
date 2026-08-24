import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { realJpeg } from '../../lib/browser-jpeg';
import { decodedSize } from '../../lib/browser-image';

/**
 * Tool-level functional tests for the ID Photo Maker.
 *
 * This tool's output is checked by somebody else, against a published rule,
 * after the person has paid a fee. A photo that is a few pixels wrong, or a
 * kilobyte under a floor, is refused - and the refusal arrives weeks later
 * from a passport office rather than from the tool.
 *
 * Its README is explicit that the interesting numbers are not the aspect
 * ratio: "Indian examination portals want 200 x 230 pixels and 20-50 KB. That
 * is a floor as well as a ceiling, and a floor cannot be met by compressing
 * less once the encoder has run out of less."
 *
 * So the tests here check the files against the figures in src/specs.js - a
 * rulebook that records the authority and the date each was read - rather than
 * against anything the page says about itself.
 */

const URL_PATH = '/id-photo/';

const MM_PER_INCH = 25.4;
/** The pixel size a print spec works out to, the way the tool must compute it. */
const printPixels = (mm: number, dpi: number): number => Math.round((mm / MM_PER_INCH) * dpi);

/** A portrait photograph for the tool to crop. */
async function portrait(page: Page): Promise<Buffer> {
  return realJpeg(page, 900, 1200, 3);
}

/** Load a photo and choose a specification. */
async function setup(page: Page, spec: string): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({
    name: 'portrait.jpg',
    mimeType: 'image/jpeg',
    buffer: await portrait(page),
  });
  await expect(page.locator('#frame-controls')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();

  await page.locator('#spec').selectOption(spec);
  // The dots open at default positions the moment a photo loads, so the crop
  // box can be fitted without anyone dragging anything.
  await page.locator('#fit-box').click();
}

interface Made {
  title: string;
  detail: string;
  bytes: Buffer;
}

/** Make the files and return every one the page offers, with its own caption. */
async function makeFiles(page: Page): Promise<Made[]> {
  await expect(page.locator('#make')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#make').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 60_000 });

  const rows = page.locator('#result-list li');
  const count = await rows.count();
  const out: Made[] = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const link = row.locator('a[download]').first();
    if (await link.count() === 0) continue;

    const pending = page.waitForEvent('download');
    await link.click();
    const saved = await pending;
    const path = await saved.path();
    if (!path) throw new Error('the browser saved no file');

    out.push({
      title: ((await row.locator('.result-title').textContent()) ?? '').trim(),
      detail: ((await row.locator('.result-detail').textContent()) ?? '').trim(),
      bytes: fs.readFileSync(path),
    });
  }

  return out;
}

test.describe('id-photo: the file a web form will accept', () => {
  test('the Indian exam photo is exactly 200 x 230 and inside 20-50 KB', async ({ page }) => {
    // The case the README singles out, and the one with a floor. Compressing
    // harder cannot fix a file that is too small, so a tool that only ever
    // squeezes downwards will fail this and pass every ceiling-only rule.
    test.setTimeout(120_000);
    await setup(page, 'in-exam-photo');

    const made = await makeFiles(page);
    expect(made.length, 'no files were produced').toBeGreaterThan(0);

    const upload = made.find((item) => /upload|online|photo/i.test(item.title)) ?? made[0];
    const size = await decodedSize(page, upload.bytes, 'image/jpeg');

    expect(size.width, 'the upload is not 200 px wide').toBe(200);
    expect(size.height, 'the upload is not 230 px tall').toBe(230);

    const kb = upload.bytes.length / 1024;
    expect(kb, `the upload is ${kb.toFixed(1)} KB, under the 20 KB floor`)
      .toBeGreaterThanOrEqual(20);
    expect(kb, `the upload is ${kb.toFixed(1)} KB, over the 50 KB ceiling`)
      .toBeLessThanOrEqual(50);

    // A JPEG, as the form requires.
    expect(upload.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

test.describe('id-photo: the print sizes are the published ones', () => {
  test('the ICAO print is 35 x 45 mm at 300 DPI', async ({ page }) => {
    // 413 x 531 pixels. Not a round number, which is exactly why it is worth
    // asserting: it can only be right by being computed from the rule.
    test.setTimeout(120_000);
    await setup(page, 'icao');

    const made = await makeFiles(page);
    const print = made.find((item) => /print/i.test(item.title)) ?? made[0];
    const size = await decodedSize(page, print.bytes, 'image/jpeg');

    expect(size.width).toBe(printPixels(35, 300));
    expect(size.height).toBe(printPixels(45, 300));
    expect(size.width).toBe(413);
    expect(size.height).toBe(531);
  });

  test('the US passport print is square, at its own size', async ({ page }) => {
    // 51 x 51 mm, not 35 x 45 - so a tool with one hard-coded shape fails here
    // while passing the test above.
    test.setTimeout(120_000);
    await setup(page, 'us-passport');

    const made = await makeFiles(page);
    const print = made.find((item) => /print/i.test(item.title)) ?? made[0];
    const size = await decodedSize(page, print.bytes, 'image/jpeg');

    expect(size.width).toBe(printPixels(51, 300));
    expect(size.height).toBe(size.width);
  });

  test('choosing a different country changes the stated rule', async ({ page }) => {
    // The facts panel is the tool's own account of what it is about to do, and
    // it has to move when the rule does - the UK's head band is not ICAO's.
    await page.goto(URL_PATH);

    await page.locator('#spec').selectOption('icao');
    const icao = ((await page.locator('#spec-facts').textContent()) ?? '').trim();

    await page.locator('#spec').selectOption('uk-passport');
    const uk = ((await page.locator('#spec-facts').textContent()) ?? '').trim();

    expect(icao.length).toBeGreaterThan(0);
    expect(uk).not.toBe(icao);

    // And each cites where its figures came from.
    await expect(page.locator('#spec-source')).not.toBeEmpty();
  });
});

test.describe('id-photo: the promise', () => {
  test('the photograph never leaves the page', async ({ page }) => {
    // The README makes the point that this matters more here than elsewhere:
    // the file is a photograph of somebody's face, and what they are about to
    // do with it names the country whose document they are applying for.
    test.setTimeout(120_000);

    const traffic: string[] = [];
    await page.goto(URL_PATH);
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const face = await portrait(page);
    await page.locator('#file-input').setInputFiles({
      name: 'face.jpg',
      mimeType: 'image/jpeg',
      buffer: face,
    });
    await expect(page.locator('#frame-controls')).toBeVisible({ timeout: 20_000 });
    await page.locator('#spec').selectOption('icao');
    await page.locator('#fit-box').click();
    await makeFiles(page);
    await page.waitForLoadState('networkidle');

    // Looked for by a distinctive slice of the file's own bytes rather than by
    // words like "jpeg" or "base64": the analytics tag legitimately reports the
    // address and title of the page being viewed, and a pattern that broad
    // flags the tool's own name while saying nothing about the file.
    const marker = face.toString('base64').slice(400, 480);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the photograph was sent').not.toContain(marker);
    }
  });
});
