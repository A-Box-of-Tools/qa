import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import {
  FIXTURE_DESCRIPTION,
  FIXTURE_MODEL,
  FIXTURE_POSITION_TEXT,
  hasExif,
  metadataSegments,
  scan,
  withExifGps,
} from '../../lib/jpeg-fixtures';
import { realJpeg } from '../../lib/browser-jpeg';

/**
 * Tool-level functional tests for the EXIF Viewer & Remover.
 *
 * Two claims, and they pull in opposite directions, which is what makes this
 * tool worth testing at the file level rather than the button level:
 *
 *   1. "Remove all metadata" really removes it - above all the GPS position,
 *      since a coordinate that survives a strip is somebody's home address
 *      published with a holiday photo.
 *   2. Removing it does not touch the picture. The README is unusually precise
 *      about what that means: "a stripped JPEG is byte-for-byte identical to
 *      its source from the SOS marker onwards", because nothing is decoded and
 *      re-encoded - it is a list edit on the container.
 *
 * A tool could pass the first by re-encoding through a canvas, which would
 * fail the second silently and cost quality on every photo run through it.
 * Both are checked here on the actual downloaded file.
 */

const URL_PATH = '/exif-editor/';


/** A JPEG carrying a description, a camera model and a GPS position. */
async function fixture(page: Page): Promise<Buffer> {
  return withExifGps(await realJpeg(page));
}

/** Hand the tool a file and wait for it to appear on the list. */
async function load(page: Page, bytes: Buffer, name = 'holiday.jpg'): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'image/jpeg',
    buffer: bytes,
  });
  await expect(page.locator('#file-list li')).toHaveCount(1);
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Click a download link and return the bytes the browser actually saved. */
async function download(page: Page, locator: string): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.locator(locator).first().click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('exif-editor: what the file gives away', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('control: the fixture really does carry a readable position', async ({ page }) => {
    // The control for every "the GPS is gone" assertion below. If the tool
    // could not read this position in the first place, a file with no GPS in
    // it afterwards would prove nothing at all - and a fixture with a wrong
    // TIFF offset would look exactly like a tool that strips well.
    const bytes = await fixture(page);
    expect(hasExif(bytes), 'the fixture has no EXIF in it').toBe(true);

    await load(page, bytes);

    const findings = page.locator('#findings-list');
    await expect(findings).toContainText('Where the photo was taken');
    await expect(findings).toContainText(FIXTURE_POSITION_TEXT);
  });

  test('the tags it found are the tags that were put in', async ({ page }) => {
    await load(page, await fixture(page));

    const groups = page.locator('#tag-groups');

    // A tag this tool can edit is rendered into an <input>, so its value is a
    // property rather than page text - toContainText would look straight past
    // it. Reading the fields back is also the better check: it is what a
    // reader would have to correct before saving.
    const editable = await groups.locator('input.tag-input').evaluateAll(
      (fields) => fields.map((field) => (field as HTMLInputElement).value),
    );
    expect(editable).toContain(FIXTURE_DESCRIPTION);
    expect(editable).toContain(FIXTURE_MODEL);

    // The GPS rationals are not editable free text, and do render as text.
    await expect(groups).toContainText('51, 30, 26.4');
    await expect(groups).toContainText('0, 7, 39.6');

    // The blocks list should name the EXIF block it is reading.
    await expect(page.locator('#block-list')).toContainText(/EXIF/i);
  });
});

test.describe('exif-editor: removing it', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('"Remove all metadata" leaves no EXIF, and no position, in the saved file', async ({ page }) => {
    const original = await fixture(page);
    await load(page, original);

    await expect(page.locator('#strip-all')).toBeEnabled();
    await page.locator('#strip-all').click();
    await expect(page.locator('#clean-results')).toBeVisible({ timeout: 20_000 });

    const cleaned = await download(page, '#result-list a[download]');

    // Nothing that parses as EXIF...
    expect(hasExif(cleaned), 'EXIF survived the strip').toBe(false);

    // ...and nothing that merely looks like it, either. A coordinate left
    // behind in a segment the parser skipped would still be in the file
    // somebody posts, so this looks at the raw bytes rather than at the
    // structure.
    expect(cleaned.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(cleaned.includes(Buffer.from(FIXTURE_MODEL, 'latin1'))).toBe(false);
    expect(cleaned.includes(Buffer.from(FIXTURE_DESCRIPTION, 'latin1'))).toBe(false);
  });

  test('the picture is untouched: identical from the SOS marker onwards', async ({ page }) => {
    // The claim that separates this tool from "draw it on a canvas and call
    // toBlob". A re-encode would pass every check above and quietly cost
    // quality on every photo; only this one notices.
    const original = await fixture(page);
    await load(page, original);

    await page.locator('#strip-all').click();
    await expect(page.locator('#clean-results')).toBeVisible({ timeout: 20_000 });
    const cleaned = await download(page, '#result-list a[download]');

    const before = scan(original);
    const after = scan(cleaned);

    expect(after.length, 'the scan changed length, so the picture was re-encoded')
      .toBe(before.length);
    expect(after.equals(before), 'the scan differs, so the picture was re-encoded')
      .toBe(true);
  });

  test('the file gets smaller by roughly what was taken out of it', async ({ page }) => {
    const original = await fixture(page);
    await load(page, original);

    await page.locator('#strip-all').click();
    await expect(page.locator('#clean-results')).toBeVisible({ timeout: 20_000 });
    const cleaned = await download(page, '#result-list a[download]');

    expect(cleaned.length).toBeLessThan(original.length);

    // And it is still a JPEG a browser will open.
    const decoded = await page.evaluate(async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        return { width: bitmap.width, height: bitmap.height };
      } catch (error) {
        return { width: 0, height: 0, error: String(error) };
      }
    }, cleaned.toString('base64'));

    expect(decoded.width, 'the stripped file no longer decodes').toBe(240);
    expect(decoded.height).toBe(160);
  });

  test('a file with nothing in it is reported as having nothing in it', async ({ page }) => {
    // The browser's own encoder writes a JFIF APP0 and no EXIF, so this is a
    // photo that never carried anything to begin with.
    const plain = await realJpeg(page);
    expect(hasExif(plain)).toBe(false);

    await load(page, plain, 'plain.jpg');
    await expect(page.locator('#findings-list')).toContainText(/Nothing in this file gives anything away/i);
  });
});

test.describe('exif-editor: the promise', () => {
  test('the photo never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.url().length > 500) {
        traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 4000)}`);
      }
    });

    await load(page, await fixture(page));
    await page.locator('#strip-all').click();
    await expect(page.locator('#clean-results')).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');

    const suspicious = traffic.filter((entry) => /image\/|base64|\/9j\/|Exif/.test(entry));
    expect(suspicious, 'something that looks like photo data was sent').toEqual([]);
  });

  test('taking a file off the list takes it off the list', async ({ page }) => {
    await page.goto(URL_PATH);
    await load(page, await fixture(page));

    await page.locator('#clear-all').click();
    await expect(page.locator('#file-list li')).toHaveCount(0);
    await expect(page.locator('#strip-all')).toBeDisabled();
  });
});
