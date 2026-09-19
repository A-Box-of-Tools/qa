import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { ask, onAPageOfItsOwn } from './engine';
import { webpFacts } from './webp';

/**
 * Driving the frame the three format converters share.
 *
 * WebP to JPG, PNG to WebP and AVIF to JPG are one module with a different
 * pair of formats at each end, and one page shape to go with it: a list of
 * files, a card of settings, a run button on a card that sleeps until there is
 * a file, and a list of results with a download each and a zip for the lot. It
 * is not the three-card frame lib/tool-frame.ts drives - these take a batch
 * and have no check line - so it is driven from here, once.
 *
 * What this does not do is believe a row. It hands back the bytes the browser
 * saved and the words the page put beside them, and it is the spec's business
 * whether the two agree.
 */

export interface Given {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface Converted {
  /** The name the page gave the file, which is also the name it saves under. */
  name: string;
  bytes: Buffer;
  /** Everything the row says, its whitespace collapsed. */
  says: string;
}

const collapse = (text: string | null): string => (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Hand files to the picker and wait until the list holds `accepted` of them.
 *
 * The count is the caller's claim about how many should get through, so a
 * refusal is tested by giving three and accepting two.
 */
export async function give(page: Page, files: Given[], accepted = files.length): Promise<void> {
  await page.locator('#file-input').setInputFiles(files);
  await expect(page.locator('#file-list li')).toHaveCount(accepted, { timeout: 60_000 });
}

/** Convert what is on the list and save every result the page offers. */
export async function convert(page: Page, { timeout = 120_000 } = {}): Promise<Converted[]> {
  await expect(
    page.locator('#run-card'),
    'the last card is still waiting for something',
  ).not.toHaveAttribute('inert', '', { timeout: 60_000 });
  await expect(page.locator('#run')).toBeEnabled({ timeout: 60_000 });
  await page.locator('#run').click();

  await expect(page.locator('#results')).toBeVisible({ timeout });
  await expect(page.locator('#run-error'), 'the run failed on what it was given').toBeHidden();

  const rows = page.locator('#result-list li');
  const count = await rows.count();
  const out: Converted[] = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const pending = page.waitForEvent('download');
    await row.locator('a[download]').click();
    const saved = await pending;
    const where = await saved.path();
    if (!where) throw new Error('the browser saved no file');

    out.push({
      name: saved.suggestedFilename(),
      bytes: fs.readFileSync(where),
      says: collapse(await row.textContent()),
    });
  }

  return out;
}

/** Save the zip the page offers for a batch. */
export async function saveZip(page: Page): Promise<Buffer> {
  await expect(page.locator('#download-zip')).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.locator('#download-zip').click();
  const saved = await pending;
  const where = await saved.path();
  if (!where) throw new Error('the browser saved no zip');
  return fs.readFileSync(where);
}

/**
 * One of the page's own sentences, with its blanks filled in.
 *
 * The words a tool's JavaScript puts on the page are held in its markup, in a
 * hidden block shared/js/phrases.js reads back, so that they are translated
 * with the rest of the page. Reading the same block is what lets a test say
 * "the row carries the sentence for a flattened picture" without carrying a
 * copy of the sentence - a copy that would be wrong the day somebody improved
 * the wording, and wrong already on every page but the English one.
 *
 * Which sentence a row carries is still the page's claim. The test's job is
 * to check that claim against the bytes.
 */
export async function sentence(
  page: Page,
  key: string,
  values: Record<string, string | number> = {},
): Promise<string> {
  const found = page.locator(`#phrases [data-phrase="${key}"]`);
  await expect(found, `the page has no phrase called ${key}`).toHaveCount(1);
  return collapse(await found.textContent())
    .replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/**
 * What this engine's canvas writes when asked for a format.
 *
 * `toBlob` does not refuse a format it cannot write - it hands back a PNG -
 * so the only way to know is to ask for one and look at the type of what
 * comes back. Asked with the browser's own canvas on a page of the probe's
 * own; nothing of the site's is involved, so a broken tool cannot answer.
 */
export async function canvasWrites(page: Page, mime: string): Promise<boolean> {
  return ask(page, `canvas-writes-${mime}`, () => onAPageOfItsOwn(page, (own) => own.evaluate(
    async (type) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const blob: Blob | null = await new Promise((done) => { canvas.toBlob(done, type, 0.8); });
      return blob?.type === type;
    },
    mime,
  )), false);
}

/**
 * Whether this engine's canvas writes the lossless WebP coding at quality 1.
 *
 * `toBlob` has no flag for lossless. Chromium switches codings at 1.0 exactly
 * and the PNG converter is built on that, reading its own output back and
 * saying "this browser wrote a lossy WebP" when the switch did not happen.
 * That sentence is honest when it is true - and it would be just as readily
 * shown by a page that had stopped asking for 1.0, blaming the browser for
 * the page's own regression. The only way to tell those apart is to know what
 * the browser does when asked properly, so it is asked here: the browser's own
 * canvas, no code of the site's, and the chunk read by lib/webp.ts.
 */
export async function canvasWritesLosslessWebp(page: Page): Promise<boolean> {
  return ask(page, 'canvas-writes-lossless-webp', async () => {
    const base64 = await onAPageOfItsOwn(page, (own) => own.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const context = canvas.getContext('2d')!;
      // Something with detail in it, so the answer is about a picture and
      // not about what an encoder does with sixteen rows of nothing.
      for (let i = 0; i < 256; i += 1) {
        context.fillStyle = `rgb(${(i * 37) & 255}, ${(i * 91) & 255}, ${(i * 53) & 255})`;
        context.fillRect(i % 16, Math.floor(i / 16), 1, 1);
      }
      const blob: Blob | null = await new Promise((done) => { canvas.toBlob(done, 'image/webp', 1); });
      if (!blob || blob.type !== 'image/webp') return '';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return btoa(String.fromCharCode(...bytes));
    }));
    return webpFacts(Buffer.from(base64, 'base64')).coding === 'VP8L';
  }, false);
}

/**
 * Whether this engine opens a file as a picture, by either road.
 *
 * Both roads, because the converters take both: `createImageBitmap` first and
 * an <img> when that refuses. An engine that fails one and passes the other
 * can still convert, so asking only one would skip tests that should run.
 */
export async function opens(page: Page, question: string, bytes: Buffer, mime: string): Promise<boolean> {
  return ask(page, `opens-${question}`, () => onAPageOfItsOwn(page, (own) => own.evaluate(
    async ({ base64, type }) => {
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) array[i] = binary.charCodeAt(i);
      const blob = new Blob([array], { type });

      try {
        const bitmap = await createImageBitmap(blob);
        bitmap.close();
        return true;
      } catch {
        // The other road.
      }

      const url = URL.createObjectURL(blob);
      try {
        return await new Promise<boolean>((done) => {
          const image = new Image();
          image.onload = () => done(image.naturalWidth > 0);
          image.onerror = () => done(false);
          setTimeout(() => done(false), 5_000);
          image.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    { base64: bytes.toString('base64'), type: mime },
  )), false);
}
