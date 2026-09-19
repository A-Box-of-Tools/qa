import { test, expect, type Page } from '@playwright/test';
import {
  AVIF_HEIGHT, AVIF_WIDTH, QUADRANTS, avifFacts, quadrantsAvif, seeThroughAvif,
} from '../../lib/avif';
import { decodedPixels, decodedSize, pixelAt, type Decoded } from '../../lib/browser-image';
import { convert, give, opens, sentence, type Given } from '../../lib/converter-frame';
import { quiet } from '../../lib/engine';
import { encodePng } from '../../lib/image-fixtures';

/**
 * Tool-level functional tests for AVIF to JPG.
 *
 * The mirror of the HEIC converter, as its README says: HEIC is decoded by
 * almost nothing and so that tool ships a decoder; AVIF is decoded by
 * everything current, so this one ships none and leans on the browser. Which
 * means there are two honest outcomes and the page owes the visitor one of
 * them. Where the browser reads AVIF, the JPEG has to be the picture that went
 * in. Where it does not, the page has to say that it is the browser - once,
 * plainly - because "this file could not be opened" invites somebody to
 * conclude their picture is broken when it is not.
 *
 * Both happen on the engines this suite runs: Chromium reads AVIF, and the
 * WebKit build on at least one of the machines it runs on does not. So the
 * engine is asked, with the fixture itself, and each half below runs where it
 * applies. Neither is a skip of the other's failure.
 *
 * The AVIFs are committed files - nothing in a browser or in lib/ can write
 * one; see fixtures/README.md - four flat quadrants of known colour, read in
 * the middle, where a lossy codec leaves a flat region alone.
 */

const URL_PATH = '/avif-to-jpg/';

const avif = (name: string, buffer: Buffer): Given => ({ name, mimeType: 'image/avif', buffer });

const readsAvif = (page: Page): Promise<boolean> => opens(page, 'avif', quadrantsAvif(), 'image/avif');

type Quadrant = { x: number; y: number; rgb: readonly number[] };

function expectColour(decoded: Decoded, at: Quadrant, colour: readonly number[], what: string): void {
  const [r, g, b] = pixelAt(decoded, at.x, at.y);
  const off = Math.max(Math.abs(r - colour[0]), Math.abs(g - colour[1]), Math.abs(b - colour[2]));
  // Two lossy codecs in a row, each good to a level or two on flat colour.
  expect(off, `${what}: found rgb(${r}, ${g}, ${b}), wanted rgb(${colour.join(', ')})`)
    .toBeLessThanOrEqual(14);
}

async function openJpeg(page: Page, bytes: Buffer): Promise<Decoded> {
  expect(bytes.subarray(0, 3), 'not a JPEG').toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  const decoded = await decodedPixels(page, bytes, 'image/jpeg');
  expect(decoded.width, `the JPEG did not decode: ${decoded.error ?? ''}`).toBeGreaterThan(0);
  return decoded;
}

test.describe('avif-to-jpg: the fixtures', () => {
  test('control: the committed files are AVIFs of the size and kind the tests expect', async () => {
    // Read from the container, by this suite's own reader, so that what the
    // conversion is held to below does not come from the browser under test.
    const opaque = avifFacts(quadrantsAvif());
    expect(opaque.brands).toContain('avif');
    expect([opaque.width, opaque.height]).toEqual([AVIF_WIDTH, AVIF_HEIGHT]);
    expect(opaque.alpha, 'the opaque fixture carries an alpha plane').toBe(false);

    const clear = avifFacts(seeThroughAvif());
    expect(clear.brands).toContain('avif');
    expect([clear.width, clear.height]).toEqual([AVIF_WIDTH, AVIF_HEIGHT]);
    expect(clear.alpha, 'the see-through fixture has no alpha plane to flatten').toBe(true);
  });

  test('a file that is not an AVIF is not evidence about the browser', async ({ page }) => {
    // The page decides a browser cannot read AVIF when every real AVIF in a
    // batch was refused. A PNG with the wrong name is not a real AVIF, and
    // must not talk the page into telling somebody their browser is too old.
    // True on every engine, so asked of every engine.
    await page.goto(URL_PATH);
    await give(page, [avif('pretender.avif', encodePng(16, 16, () => [10, 20, 30]))], 0);

    await expect(page.locator('#load-error')).toContainText(await sentence(page, 'read.notavif', {
      name: 'pretender.avif',
      found: await sentence(page, 'found.png'),
    }));
    await expect(page.locator('#support-error')).toBeHidden();
    await expect(page.locator('#run-card')).toHaveAttribute('inert', '');
  });
});

test.describe('avif-to-jpg: where the browser reads AVIF', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await readsAvif(page)), 'this engine does not open AVIF; see the refusal below');
  });

  test('the JPEG is the picture that went in, at the size the AVIF declares', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [avif('saved-from-web.avif', quadrantsAvif())]);
    await expect(page.locator('#support-error')).toBeHidden();

    const [made] = await convert(page);
    expect(made.name).toBe('saved-from-web.jpg');

    const jpeg = await openJpeg(page, made.bytes);
    expect([jpeg.width, jpeg.height]).toEqual([AVIF_WIDTH, AVIF_HEIGHT]);
    for (const [name, quadrant] of Object.entries(QUADRANTS)) {
      expectColour(jpeg, quadrant, quadrant.rgb, name);
    }
  });

  test('the see-through parts take the colour that was chosen', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [avif('sticker.avif', seeThroughAvif())]);

    await expect(page.locator('#background-row')).toBeVisible();
    await page.locator('#background').fill('#3366cc');

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    const chosen = [0x33, 0x66, 0xcc];
    expectColour(jpeg, QUADRANTS.topRight, chosen, 'top right, which was see-through');
    expectColour(jpeg, QUADRANTS.bottomRight, chosen, 'bottom right, which was see-through');
    expectColour(jpeg, QUADRANTS.topLeft, QUADRANTS.topLeft.rgb, 'top left, which was solid');
    expectColour(jpeg, QUADRANTS.bottomLeft, QUADRANTS.bottomLeft.rgb, 'bottom left, which was solid');

    expect(made.says).toContain(await sentence(page, 'result.flattened', { colour: '#3366cc' }));
  });

  test('left alone, they come out white and not black', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [avif('sticker.avif', seeThroughAvif())]);

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, QUADRANTS.topRight, [255, 255, 255], 'where the picture was see-through');
  });

  test('an opaque photograph is not offered a colour it has no use for', async ({ page }) => {
    // Most AVIFs people arrive with are photographs saved off a web page.
    await page.goto(URL_PATH);
    await give(page, [avif('photo.avif', quadrantsAvif())]);
    await expect(page.locator('#background-row')).toBeHidden();

    const [made] = await convert(page);
    expect(made.says).not.toContain(await sentence(page, 'result.flattened', { colour: '#ffffff' }));
  });

  test('an AVIF that arrived called .jpg is converted', async ({ page }) => {
    // The brands decide, never the extension: a download that renamed the
    // file is exactly the file somebody cannot open.
    await page.goto(URL_PATH);
    await give(page, [{ name: 'image.jpg', mimeType: 'image/jpeg', buffer: quadrantsAvif() }]);

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, QUADRANTS.topLeft, QUADRANTS.topLeft.rgb, 'top left');
  });

  test('the example is two real AVIFs, and both come back as JPEGs', async ({ page }) => {
    // The only example on the site besides the HEIC one that is committed
    // bytes rather than a drawing, fetched on the press and not before - so
    // the press is also the test that the fetch is allowed and works.
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    await page.locator('#example-button').click();
    await expect(page.locator('#file-list li')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.locator('#load-error')).toBeHidden();

    const made = await convert(page);
    expect(made.map((one) => one.name)).toEqual(['example-landscape.jpg', 'example-square.jpg']);

    const landscape = await decodedSize(page, made[0].bytes, 'image/jpeg');
    const square = await decodedSize(page, made[1].bytes, 'image/jpeg');
    expect(landscape.width).toBeGreaterThan(landscape.height);
    expect(square.width).toBeGreaterThan(0);
    expect(square.width).toBe(square.height);
  });

  test('the picture never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = quadrantsAvif();
    await give(page, [avif('private.avif', bytes)]);
    await convert(page);
    await quiet(page);

    const marker = bytes.toString('base64').slice(200, 280);
    expect(marker.length).toBe(80);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});

test.describe('avif-to-jpg: where the browser does not', () => {
  test('the page says it is the browser, once, and offers nothing it cannot do', async ({ page }) => {
    test.skip(await readsAvif(page), 'this engine opens AVIF, so there is nothing for the page to refuse');

    // Two good files. The failure the README names is "three identical
    // complaints about files that are perfectly good" with no word about why.
    await page.goto(URL_PATH);
    await give(page, [avif('one.avif', quadrantsAvif()), avif('two.avif', seeThroughAvif())], 0);

    await expect(page.locator('#support-error')).toContainText(await sentence(page, 'support.noavif'));
    await expect(page.locator('#file-list li')).toHaveCount(0);
    await expect(page.locator('#run')).toBeDisabled();
  });
});
