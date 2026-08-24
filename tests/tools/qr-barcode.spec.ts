import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Tool-level functional tests for the QR & Barcode Generator, verified by
 * running its output back through the QR & Barcode Reader.
 *
 * A wrong QR code is the quietest failure on this site. It renders, it looks
 * like a QR code, it downloads, it goes on the poster - and it fails at the
 * only moment that matters, in somebody else's camera, days later. Nothing
 * about looking at one tells you whether it is right.
 *
 * So nothing here checks that a code "was drawn". Every test makes a code,
 * saves the PNG, hands it to the reader, and requires the text that comes back
 * to be the text that went in. The two tools are separate implementations -
 * qr-encode.js and gf256.js on one side, qr-decode.js and reed-solomon.js on
 * the other - which is what makes the round trip worth something. They do
 * share qr-tables.js and payload.js, so a wrong table could in principle
 * cancel itself out; the fixed, published values asserted below (the version
 * and level the reader reports, and the EAN-13 check digit) are there to
 * narrow that gap.
 *
 * The Wi-Fi test is not an afterthought: the generator's own README says "the
 * single most common thing people put in a QR code is the password to their
 * Wi-Fi".
 */

/**
 * Every test in this file loads two pages and decodes a QR code, which is
 * image processing rather than DOM work. Alone that is a few seconds; with
 * the other workers busy it is comfortably past the default budget, and the
 * whole file went red for want of time rather than for want of correctness.
 * Given room here rather than by capping workers globally, which would slow
 * every other spec down to suit this one.
 */
test.describe.configure({ timeout: 120_000 });

const ENCODER = '/qr-barcode/';
const READER = '/qr-barcode-reader/';

/** Make a code with the current settings and return the PNG the browser saved. */
async function savePng(page: Page): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.locator('#download-png').click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no PNG');
  return fs.readFileSync(path);
}

interface Decoded {
  text: string;
  kind: string;
  symbology: string;
  version: string;
  level: string;
}

/** Hand a PNG to the reader tool and return what it made of it. */
async function decode(page: Page, png: Buffer, name = 'code.png'): Promise<Decoded> {
  await page.goto(READER);
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: png,
  });

  await expect(page.locator('#results-card')).toBeVisible({ timeout: 30_000 });
  const result = page.locator('#results .result').first();
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#pick-error')).toBeHidden();

  const textOf = async (selector: string): Promise<string> => (
    ((await result.locator(selector).first().textContent()) ?? '').trim()
  );

  return {
    // Deliberately not trimmed. The decoded payload is the thing under test,
    // and trimming it here would quietly forgive a lost leading or trailing
    // space - which is exactly the kind of round-trip bug worth catching, and
    // did in fact hide one from an earlier version of this helper. The
    // metadata fields below are trimmed, because their whitespace is markup
    // indentation rather than data.
    text: ((await result.locator('.result-text').first().textContent()) ?? ''),
    kind: await textOf('.result-kind'),
    symbology: await textOf('.result-symbology'),
    version: await textOf('[data-fact="version"]'),
    level: await textOf('[data-fact="level"]'),
  };
}

/** The pixel width recorded in a PNG's IHDR chunk. */
const pngWidth = (png: Buffer): number => png.readUInt32BE(16);

test.describe('qr-barcode: a code that says what was put in it', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(ENCODER);
    await page.locator('#symbology').selectOption('qr');
  });

  test('plain text comes back out of its own QR code', async ({ page }) => {
    const message = 'A Box of Tools - QA round trip';
    await page.locator('#field-text').fill(message);

    const decoded = await decode(page, await savePng(page));
    expect(decoded.text).toBe(message);
    expect(decoded.symbology).toMatch(/QR/i);
  });

  test('a web address survives, including its punctuation', async ({ page }) => {
    // URLs are where a single wrong character is both most likely to happen
    // and least likely to be noticed by eye.
    const url = 'https://abox.tools/qr-barcode/?a=1&b=2#frag';
    await page.locator('#field-text').fill(url);

    const decoded = await decode(page, await savePng(page));
    expect(decoded.text).toBe(url);
  });

  test('non-ASCII text survives the byte mode', async ({ page }) => {
    // Anything outside the alphanumeric set has to go through byte mode as
    // UTF-8; a mode chosen wrongly produces a code that decodes to mojibake
    // rather than to nothing, which is the harder failure to spot.
    const message = 'café — naïve — 東京 — 🧰';
    await page.locator('#field-text').fill(message);

    const decoded = await decode(page, await savePng(page));
    expect(decoded.text).toBe(message);
  });

  test('a long string still round-trips, at a higher version', async ({ page }) => {
    const long = 'The quick brown fox jumps over the lazy dog. '.repeat(8);
    await page.locator('#field-text').fill(long);

    const decoded = await decode(page, await savePng(page));
    expect(decoded.text).toBe(long);
    // More data needs a bigger symbol; version 1 could not hold this.
    expect(Number(decoded.version.replace(/\D/g, ''))).toBeGreaterThan(1);
  });

  test('the error-correction level asked for is the level in the code', async ({ page }) => {
    // Not cosmetic: it decides how much of a worn or partly covered code can
    // still be read, and it is the setting a user is most likely to change
    // deliberately.
    for (const level of ['L', 'M', 'Q', 'H']) {
      await page.goto(ENCODER);
      await page.locator('#symbology').selectOption('qr');
      await page.locator('#field-text').fill(`level ${level}`);
      await page.locator('#level').selectOption(level);

      const decoded = await decode(page, await savePng(page));
      expect(decoded.text).toBe(`level ${level}`);
      expect(decoded.level, `the code was not made at level ${level}`).toContain(level);
    }
  });

  test('the PNG is the size the page says it is, not the size that was asked for', async ({ page }) => {
    // A module has to be a whole number of pixels, or its edges land on a
    // half pixel and the code renders soft enough to stop scanning. So the
    // tool snaps down - 256 asked for, 29 modules across, 8 pixels each, 232
    // - and says so in the note rather than silently resizing. The check that
    // matters is that the file agrees with what the page claims.
    await page.locator('#field-text').fill('size check');
    await page.locator('#size').fill('256');

    const note = (await page.locator('#size-note').textContent()) ?? '';
    const claimed = Number(note.match(/(\d+)\s*pixels square/)?.[1]);
    expect(claimed, `could not read a size out of: ${note}`).toBeGreaterThan(0);

    const png = await savePng(page);
    expect(pngWidth(png)).toBe(claimed);
    expect(pngWidth(png)).toBeLessThanOrEqual(256);

    // Snapped down by less than one module, and still readable.
    expect(256 - pngWidth(png)).toBeLessThan(32);
    expect((await decode(page, png)).text).toBe('size check');
  });
});

test.describe('qr-barcode: the Wi-Fi password people actually put in these', () => {
  test('a Wi-Fi code carries the network and the password back', async ({ page }) => {
    await page.goto(ENCODER);
    await page.locator('#symbology').selectOption('qr');
    await page.locator('#format').selectOption('wifi');

    const ssid = 'The Coffee Shop';
    const password = 'hunter2-correct-horse';
    await page.locator('#field-ssid').fill(ssid);
    await page.locator('#field-password').fill(password);

    const decoded = await decode(page, await savePng(page));

    // The payload is the WIFI: form a phone knows how to join from.
    expect(decoded.text).toContain(ssid);
    expect(decoded.text).toContain(password);
    expect(decoded.text).toMatch(/^WIFI:/);
    // And the reader recognises what kind of thing it is, rather than showing
    // a wall of punctuation.
    expect(decoded.kind).toMatch(/wi-?fi/i);
  });

  test('a Wi-Fi password never leaves the page', async ({ page }) => {
    // The generator's README makes the point that this tool has no file input
    // at all, so "there is nothing to be tempted by" - but the string in the
    // box is a secret in its own right.
    await page.goto(ENCODER);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 4000)}`);
    });

    const password = 'a-password-that-must-not-be-sent';
    await page.locator('#symbology').selectOption('qr');
    await page.locator('#format').selectOption('wifi');
    await page.locator('#field-ssid').fill('Home');
    await page.locator('#field-password').fill(password);
    await savePng(page);
    await page.waitForLoadState('networkidle');

    for (const entry of traffic) {
      expect(entry, 'the Wi-Fi password was sent somewhere').not.toContain(password);
      expect(entry, 'the password was sent url-encoded').not.toContain(
        encodeURIComponent(password),
      );
    }
  });
});

test.describe('qr-barcode: the linear barcodes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(ENCODER);
  });

  test('an EAN-13 round-trips, check digit and all', async ({ page }) => {
    // 5901234123457 is the example from the EAN specification, and 7 is its
    // correct check digit - a fixed, published value neither tool computed.
    await page.locator('#symbology').selectOption('ean13');
    await page.locator('#field-text').fill('5901234123457');

    const decoded = await decode(page, await savePng(page));
    expect(decoded.text).toBe('5901234123457');
    expect(decoded.symbology).toMatch(/EAN/i);
  });

  test('Code 128 round-trips a mixed string', async ({ page }) => {
    await page.locator('#symbology').selectOption('code128');
    const value = 'ABC-12345-xyz';
    await page.locator('#field-text').fill(value);

    const decoded = await decode(page, await savePng(page));
    expect(decoded.text).toBe(value);
    expect(decoded.symbology).toMatch(/128/);
  });

  test('an EAN-13 with the wrong number of digits is refused, not drawn', async ({ page }) => {
    // Drawing something for input that cannot be a valid EAN-13 would be
    // worse than refusing: it would scan as the wrong product.
    await page.locator('#symbology').selectOption('ean13');
    await page.locator('#field-text').fill('12345');

    await expect(page.locator('#input-error')).toBeVisible();
  });

  test('an EAN-13 with a wrong check digit is refused', async ({ page }) => {
    await page.locator('#symbology').selectOption('ean13');
    await page.locator('#field-text').fill('5901234123450'); // 7 is correct

    await expect(page.locator('#input-error')).toBeVisible();
  });
});
