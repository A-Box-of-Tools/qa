import { test, expect, type Page } from '@playwright/test';
import { realJpeg } from '../../lib/browser-jpeg';
import { decodedSize } from '../../lib/browser-image';

/**
 * Tool-level functional tests for Image to Data URI.
 *
 * The output of this tool is pasted straight into a stylesheet or a template,
 * where a wrong answer does not throw - it renders as a broken image icon in
 * production. The two ways to be wrong are both quiet: base64 that does not
 * decode back to the original bytes, and a MIME type that does not match what
 * the bytes actually are.
 *
 * So the tests decode the URI the tool produced, compare the bytes with the
 * file that went in, and check the browser will open the result.
 */

const URL_PATH = '/image-to-data-uri/';

async function load(page: Page, bytes: Buffer, name = 'picture.jpg'): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: name.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg',
    buffer: bytes,
  });
  await expect(page.locator('#file-list li')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
  await expect(page.locator('#results')).toBeVisible({ timeout: 20_000 });
}

/**
 * The full text of the first result.
 *
 * The row shows a truncated snippet with an ellipsis on it until "Show all N
 * characters" is pressed - reading it without doing that returns a few hundred
 * characters of a data URI and quietly compares the wrong thing, which is how
 * the first version of this helper managed to report an 885-byte JPEG.
 */
async function output(page: Page): Promise<string> {
  const row = page.locator('#result-list li').first();
  await expect(row).toBeVisible({ timeout: 20_000 });

  const showAll = row.locator('.show-all');
  if (await showAll.count() > 0) await showAll.first().click();

  return ((await row.locator('.result-code').first().textContent()) ?? '').trim();
}

/** Pull the data: URI out of whatever shape it was wrapped in. */
function extractUri(text: string): string {
  const match = text.match(/data:[^\s"')]+/);
  if (!match) throw new Error(`no data: URI in the output: ${text.slice(0, 200)}`);
  return match[0];
}

test.describe('image-to-data-uri: the bytes come back', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('the base64 decodes to exactly the file that went in', async ({ page }) => {
    // The whole job. A URI that decodes to almost the original renders as a
    // broken image, and there is nothing on this page that would show it.
    const jpeg = await realJpeg(page, 200, 140, 21);
    await load(page, jpeg);

    const uri = extractUri(await output(page));
    expect(uri).toMatch(/^data:image\/jpeg;base64,/);

    const decoded = Buffer.from(uri.split(',')[1], 'base64');
    expect(decoded.length).toBe(jpeg.length);
    expect(decoded.equals(jpeg), 'the encoded bytes are not the file').toBe(true);
  });

  test('the URI is one a browser will actually open', async ({ page }) => {
    const jpeg = await realJpeg(page, 160, 120, 22);
    await load(page, jpeg);
    const uri = extractUri(await output(page));

    // Loaded through an <img>, not fetch(). The site's connect-src does not
    // allow data:, so fetching one is refused by the page's own policy - and
    // an <img> is how this output is actually used anyway, whether pasted into
    // a stylesheet or a template.
    const size = await page.evaluate(async (href) => new Promise<{
      width: number; height: number; error?: string;
    }>((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0, error: 'the browser refused the URI' });
      image.src = href;
    }), uri);

    expect(size.width, `the URI did not decode: ${size.error ?? ''}`).toBe(160);
    expect(size.height).toBe(120);
  });

  test('the media type matches what the bytes are', async ({ page }) => {
    // A JPEG announced as image/png is the other silent failure: some
    // browsers sniff and render it anyway, and some do not.
    const jpeg = await realJpeg(page, 100, 100, 23);
    await load(page, jpeg);

    const uri = extractUri(await output(page));
    expect(uri.startsWith('data:image/jpeg')).toBe(true);

    const decoded = Buffer.from(uri.split(',')[1], 'base64');
    expect(decoded.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

test.describe('image-to-data-uri: the shapes it can be pasted in', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('a CSS rule wraps the same URI in url()', async ({ page }) => {
    const jpeg = await realJpeg(page, 120, 90, 24);
    await load(page, jpeg);

    const plain = extractUri(await output(page));

    await page.locator('input[name="shape"][value="css-rule"]').check();
    const rule = await output(page);

    expect(rule).toContain('url(');
    expect(rule).toContain('background-image');
    // The URI inside the wrapper is the same one, not a re-encode.
    expect(extractUri(rule)).toBe(plain);
  });

  test('a custom property is a custom property', async ({ page }) => {
    const jpeg = await realJpeg(page, 120, 90, 25);
    await load(page, jpeg);

    await page.locator('input[name="shape"][value="css-var"]').check();
    const text = await output(page);

    expect(text).toMatch(/--[\w-]+\s*:/);
    expect(text).toContain('url(');
    expect(() => extractUri(text)).not.toThrow();
  });
});

test.describe('image-to-data-uri: the promise', () => {
  test('the picture never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const jpeg = await realJpeg(page, 200, 200, 26);
    await load(page, jpeg, 'private.jpg');
    await output(page);
    await page.waitForLoadState('networkidle');

    // A distinctive slice of the file's own base64, rather than a word like
    // "jpeg": the analytics tag legitimately reports this page's address and
    // title, and a broad pattern flags the tool's own name.
    const marker = jpeg.toString('base64').slice(300, 380);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});
