import { test, expect, type Page } from '@playwright/test';
import { decodedPixels, pixelAt, type Decoded } from '../../lib/browser-image';
import { convert, give, saveZip, sentence, type Given } from '../../lib/converter-frame';
import { quiet } from '../../lib/engine';
import { encodePng } from '../../lib/image-fixtures';
import { encodeAnimatedWebp, encodeWebp, webpFacts, type Rgba } from '../../lib/webp';
import { zipEntries } from '../../lib/zip';

/**
 * Tool-level functional tests for WebP to JPG.
 *
 * The pipeline is three calls - decode, draw, encode - and its README says as
 * much. What makes it a tool rather than a canvas call is the two things a
 * WebP can hold that a JPEG cannot, and both fail in a way that looks like a
 * finished job: the see-through parts of a logo come out black, which "reads
 * as a bug in the tool rather than as a property of JPEG", and an animation
 * arrives as one frame with nothing to say which. A JPEG opens either way.
 *
 * So the WebPs here are written by lib/webp.ts, pixel by known pixel, and the
 * JPEGs are opened again and looked at. Flat regions, read in the middle:
 * JPEG is lossy and smears at an edge, and the question being asked is "which
 * colour is this", not "is it the same to the last digit".
 */

const URL_PATH = '/webp-to-jpg/';

const WIDTH = 96;
const HEIGHT = 64;

const RED: Rgba = [200, 30, 30, 255];
const GREEN: Rgba = [30, 200, 30, 255];
/** Nothing there. The colour underneath is one the writer's two-value channels allow. */
const CLEAR: Rgba = [30, 30, 30, 0];

const WHITE = [255, 255, 255] as const;
const BLACK = [0, 0, 0] as const;

/** Red above, green below, solid throughout. */
const twoTone = (): Buffer => encodeWebp(WIDTH, HEIGHT, (_x, y) => (y < HEIGHT / 2 ? RED : GREEN));

/** Red on the left, nothing on the right. */
const seeThrough = (options?: { extended?: boolean }): Buffer => (
  encodeWebp(WIDTH, HEIGHT, (x) => (x < WIDTH / 2 ? RED : CLEAR), options)
);

/** A red frame and then a green one. */
const animated = (): Buffer => encodeAnimatedWebp(WIDTH, HEIGHT, [
  { paint: () => RED, ms: 200 },
  { paint: () => GREEN, ms: 200 },
]);

/**
 * Detail, for the tests that need a file with something in it to lose: each
 * channel flips between two values from pixel to pixel, by a generator with a
 * fixed seed so that every run gets the same file.
 */
function noise(): Buffer {
  let state = 0x2f6e2b1;
  const bit = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 16) & 1;
  };
  const pixels: Rgba[] = [];
  for (let i = 0; i < 128 * 96; i += 1) {
    pixels.push([bit() ? 220 : 35, bit() ? 210 : 45, bit() ? 200 : 25, 255]);
  }
  return encodeWebp(128, 96, (x, y) => pixels[(y * 128) + x]);
}

const webp = (name: string, buffer: Buffer): Given => ({ name, mimeType: 'image/webp', buffer });

/** Middle of the left and right halves, and of the top and bottom ones. */
const LEFT = { x: WIDTH / 4, y: HEIGHT / 2 };
const RIGHT = { x: (WIDTH * 3) / 4, y: HEIGHT / 2 };
const TOP = { x: WIDTH / 2, y: HEIGHT / 4 };
const BOTTOM = { x: WIDTH / 2, y: (HEIGHT * 3) / 4 };

/** A colour, give or take what a JPEG does to the middle of a flat region. */
function expectColour(
  decoded: Decoded,
  at: { x: number; y: number },
  colour: readonly number[],
  what: string,
): void {
  const [r, g, b] = pixelAt(decoded, at.x, at.y);
  const off = Math.max(Math.abs(r - colour[0]), Math.abs(g - colour[1]), Math.abs(b - colour[2]));
  expect(off, `${what}: found rgb(${r}, ${g}, ${b}), wanted rgb(${colour.join(', ')})`)
    .toBeLessThanOrEqual(12);
}

async function openJpeg(page: Page, bytes: Buffer): Promise<Decoded> {
  expect(bytes.subarray(0, 3), 'not a JPEG').toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  const decoded = await decodedPixels(page, bytes, 'image/jpeg');
  expect(decoded.width, `the JPEG did not decode: ${decoded.error ?? ''}`).toBeGreaterThan(0);
  return decoded;
}

test.describe('webp-to-jpg: the fixtures', () => {
  test('control: the WebPs written here are what the tests take them for', async ({ page }) => {
    // Every file below comes from an encoder in this repository, so before
    // anything is concluded from a conversion, the files themselves are held
    // to account: by their chunks, and by the browser that will be given them.
    await page.goto(URL_PATH);

    const flat = webpFacts(seeThrough());
    expect(flat.coding).toBe('VP8L');
    expect(flat.alphaFlag, 'the extended layout should declare its alpha').toBe(true);
    expect(webpFacts(seeThrough({ extended: false })).chunks).toEqual(['VP8L']);
    expect(webpFacts(animated()).frames).toBe(2);

    const opened = await decodedPixels(page, seeThrough(), 'image/webp');
    expect([opened.width, opened.height]).toEqual([WIDTH, HEIGHT]);
    expect(pixelAt(opened, LEFT.x, LEFT.y)).toEqual([...RED]);
    // Really see-through, so "it came out black" is a failure this can have.
    expect(pixelAt(opened, RIGHT.x, RIGHT.y)[3]).toBe(0);
  });
});

test.describe('webp-to-jpg: converting', () => {
  test('the JPEG is the picture that went in, under the same name', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [webp('holiday.webp', twoTone())]);

    const [made] = await convert(page);
    // The old extension dropped rather than kept: "holiday.webp.jpg" is
    // unopenable on half the phones that meet it.
    expect(made.name).toBe('holiday.jpg');

    const jpeg = await openJpeg(page, made.bytes);
    expect([jpeg.width, jpeg.height]).toEqual([WIDTH, HEIGHT]);
    expectColour(jpeg, TOP, RED, 'the top half');
    expectColour(jpeg, BOTTOM, GREEN, 'the bottom half');
  });

  test('a lower quality gives a smaller file', async ({ page }) => {
    // The slider has to be a scale and not a label.
    await page.goto(URL_PATH);
    await give(page, [webp('detail.webp', noise())]);

    await page.locator('#quality').fill('95');
    const [high] = await convert(page);
    await page.locator('#quality').fill('45');
    const [low] = await convert(page);

    expect(low.bytes.length).toBeLessThan(high.bytes.length);
  });

  test('a batch keeps two files of the same name apart, in the zip as well', async ({ page }) => {
    // Two files called the same thing from two folders are one entry in most
    // unzippers, the second replacing the first - silently, and after the
    // page has said it converted two.
    await page.goto(URL_PATH);
    await give(page, [webp('logo.webp', twoTone()), webp('logo.webp', animated())]);

    const made = await convert(page);
    expect(made.map((one) => one.name)).toEqual(['logo.jpg', 'logo-2.jpg']);

    const entries = zipEntries(await saveZip(page));
    expect(entries.map((entry) => entry.name)).toEqual(['logo.jpg', 'logo-2.jpg']);
    // And they are the files, not two copies of one of them.
    expect(entries[0].data.equals(made[0].bytes)).toBe(true);
    expect(entries[1].data.equals(made[1].bytes)).toBe(true);
    expect(entries[0].data.equals(entries[1].data)).toBe(false);
  });
});

test.describe('webp-to-jpg: what a JPEG cannot hold', () => {
  test('the see-through parts take the colour that was chosen', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [webp('logo.webp', seeThrough())]);

    // The field is only offered when something on the list needs it.
    await expect(page.locator('#background-row')).toBeVisible();
    await page.locator('#background').fill('#3366cc');

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, RIGHT, [0x33, 0x66, 0xcc], 'where the picture was see-through');
    expectColour(jpeg, LEFT, RED, 'the solid half');

    // And the row says what was done, in the page's own words.
    expect(made.says).toContain(await sentence(page, 'result.flattened', { colour: '#3366cc' }));
  });

  test('left alone, they come out white and not black', async ({ page }) => {
    // The default nobody chose is the one most people get. Black is what a
    // canvas gives a JPEG when nothing is painted first, and it is where every
    // "my logo has a black background now" comes from.
    await page.goto(URL_PATH);
    await give(page, [webp('logo.webp', seeThrough())]);

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, RIGHT, WHITE, 'where the picture was see-through');

    const [r, g, b] = pixelAt(jpeg, RIGHT.x, RIGHT.y);
    expect(r + g + b, 'the see-through half came out black').toBeGreaterThan(BLACK.length * 200);
  });

  test('alpha the file header does not mention is still not left black', async ({ page }) => {
    // The simple layout is the pixel chunk and nothing else: its alpha is
    // declared inside the bitstream, where a reader that only walks chunks
    // cannot see it. The tool's README accepts that such a file may not be
    // offered a colour. What it may not do is fall through to black - so this
    // asks nothing about the field and everything about the pixels.
    await page.goto(URL_PATH);
    await give(page, [webp('logo.webp', seeThrough({ extended: false }))]);

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, RIGHT, WHITE, 'where the picture was see-through');
    expectColour(jpeg, LEFT, RED, 'the solid half');
  });

  test('an opaque file is not offered a colour it has no use for', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [webp('photo.webp', twoTone())]);
    await expect(page.locator('#background-row')).toBeHidden();
  });

  test('an animation gives its first frame, and says so before and after', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [webp('spinner.webp', animated())]);

    // Before: on the file's own row, so nobody finds out in a downloads folder.
    await expect(page.locator('#file-list li')).toContainText(await sentence(page, 'file.animated'));

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, TOP, RED, 'the frame that was written');
    expectColour(jpeg, BOTTOM, RED, 'the frame that was written');

    expect(made.says).toContain(await sentence(page, 'result.firstframe'));
  });

  test('a still is not called an animation', async ({ page }) => {
    // The other half of the claim above: a note that is on every row is a
    // note about nothing.
    await page.goto(URL_PATH);
    await give(page, [webp('photo.webp', twoTone())]);

    const [made] = await convert(page);
    expect(made.says).not.toContain(await sentence(page, 'result.firstframe'));
    expect(made.says).not.toContain(await sentence(page, 'result.flattened', { colour: '#ffffff' }));
  });
});

test.describe('webp-to-jpg: a file is what its bytes say', () => {
  test('a WebP that arrived called .jpg is converted', async ({ page }) => {
    // One of the commonest reasons anybody is looking for this page: the file
    // will not open, and its name says it should.
    await page.goto(URL_PATH);
    await give(page, [{ name: 'download.jpg', mimeType: 'image/jpeg', buffer: twoTone() }]);

    const [made] = await convert(page);
    const jpeg = await openJpeg(page, made.bytes);
    expectColour(jpeg, TOP, RED, 'the top half');
  });

  test('a PNG called .webp is refused by name, and the rest of the batch goes on', async ({ page }) => {
    await page.goto(URL_PATH);
    const png = encodePng(16, 16, () => [10, 20, 30]);
    await give(page, [
      webp('real.webp', twoTone()),
      { name: 'pretender.webp', mimeType: 'image/webp', buffer: png },
    ], 1);

    await expect(page.locator('#load-error')).toContainText(await sentence(page, 'read.notwebp', {
      name: 'pretender.webp',
      found: await sentence(page, 'found.png'),
    }));

    const made = await convert(page);
    expect(made.map((one) => one.name)).toEqual(['real.jpg']);
  });

  test('when nothing on the list is a WebP, there is nothing to run', async ({ page }) => {
    // The picker wakes the last card the moment files arrive; a batch that was
    // refused whole must put it back to sleep rather than leave a live button
    // over an empty list.
    await page.goto(URL_PATH);
    await give(page, [{
      name: 'pretender.webp', mimeType: 'image/webp', buffer: encodePng(16, 16, () => [10, 20, 30]),
    }], 0);

    await expect(page.locator('#load-error')).toBeVisible();
    await expect(page.locator('#run')).toBeDisabled();
    await expect(page.locator('#run-card')).toHaveAttribute('inert', '');
  });
});

test.describe('webp-to-jpg: the promise', () => {
  test('the picture never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = noise();
    await give(page, [webp('private.webp', bytes)]);
    await convert(page);
    await quiet(page);

    const marker = bytes.toString('base64').slice(400, 480);
    expect(marker.length).toBe(80);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});
