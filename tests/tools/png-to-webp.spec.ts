import { test, expect, type Page } from '@playwright/test';
import { decodedPixels, type Decoded } from '../../lib/browser-image';
import {
  canvasWrites, canvasWritesLosslessWebp, convert, give, sentence, type Given,
} from '../../lib/converter-frame';
import { quiet } from '../../lib/engine';
import { encodePng, type Rgba } from '../../lib/image-fixtures';
import { encodeWebp, webpFacts } from '../../lib/webp';

/**
 * Tool-level functional tests for PNG to WebP.
 *
 * The page makes one claim that matters - "Lossless: every pixel is the one
 * the PNG had" - and its README is frank about what that rests on: a canvas
 * has no flag for lossless WebP, Chromium happens to switch codings at quality
 * 1.0 exactly, and "that is the behaviour of an engine rather than a promise
 * of the specification". So the tool reads its own output back and reports
 * which coding came out.
 *
 * That makes two things to check and neither can be taken from the page. One
 * is the claim itself: the PNG here is written pixel by known pixel, and the
 * WebP is decoded and compared with those numbers, all of them. The other is
 * the reporting: whichever coding the bytes are in, the row has to say that
 * one - so the chunk is read here, by lib/webp.ts, and the row is held to it.
 * A browser that stopped honouring 1.0 would not be the site's fault. A row
 * that went on saying "lossless" over a lossy file would be.
 */

const URL_PATH = '/png-to-webp/';

const WIDTH = 64;
const HEIGHT = 48;

/** No two neighbours alike, so a lossy coding has something to get wrong. */
const busy = (x: number, y: number): Rgba => [
  (x * 4) & 255,
  (y * 5) & 255,
  ((x * 7) ^ (y * 13)) & 255,
  255,
];

/** Solid on the left, half there in the middle, not there at all on the right. */
const fading = (x: number, y: number): Rgba => {
  const [r, g, b] = busy(x, y);
  if (x < 24) return [r, g, b, 255];
  if (x < 44) return [r, g, b, 128];
  return [r, g, b, 0];
};

const png = (name: string, buffer: Buffer): Given => ({ name, mimeType: 'image/png', buffer });

async function openWebp(page: Page, bytes: Buffer): Promise<Decoded> {
  expect(bytes.subarray(0, 4).toString('latin1'), 'not a RIFF file').toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('latin1'), 'not a WebP').toBe('WEBP');
  const decoded = await decodedPixels(page, bytes, 'image/webp');
  expect(decoded.width, `the WebP did not decode: ${decoded.error ?? ''}`).toBe(WIDTH);
  expect(decoded.height).toBe(HEIGHT);
  return decoded;
}

interface Difference {
  /** Pixels whose colour is not the one painted, among the fully solid ones. */
  solid: number;
  /** Pixels whose alpha is not the one painted. */
  alpha: number;
  /** The largest error in any channel of a solid pixel. */
  worst: number;
  first: string;
}

/** Hold a decoded picture against the function that painted the original. */
function compare(decoded: Decoded, paint: (x: number, y: number) => Rgba): Difference {
  const out: Difference = { solid: 0, alpha: 0, worst: 0, first: '' };
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const want = paint(x, y);
      const at = ((y * decoded.width) + x) * 4;
      const got = [...decoded.rgba.subarray(at, at + 4)];

      if (got[3] !== want[3]) out.alpha += 1;
      // Only a solid pixel's colour is the file's to keep. Under a pixel that
      // is partly see-through the canvas has already multiplied it away, in
      // the PNG's decode as much as in the WebP's - see the README's table.
      if (want[3] !== 255) continue;

      const off = Math.max(...[0, 1, 2].map((c) => Math.abs(got[c] - want[c])));
      if (off > 0) {
        out.solid += 1;
        out.worst = Math.max(out.worst, off);
        out.first ||= `(${x}, ${y}) is ${got.join(',')} and was painted ${want.join(',')}`;
      }
    }
  }
  return out;
}

test.describe('png-to-webp: the fixture', () => {
  test('control: the PNG decodes to exactly the numbers it was painted with', async ({ page }) => {
    // Everything below compares a WebP with `busy`, not with the PNG. That is
    // only fair if the PNG itself reads back as `busy` in this browser: if a
    // colour profile or a gamma chunk nudged it, a perfect conversion would
    // be blamed for the nudge.
    await page.goto(URL_PATH);

    const opened = await decodedPixels(page, encodePng(WIDTH, HEIGHT, busy));
    const difference = compare(opened, busy);
    expect(difference.solid, difference.first).toBe(0);

    // And it is busy: a picture of one flat colour would survive any coding.
    const colours = new Set<string>();
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) colours.add(busy(x, y).join());
    }
    expect(colours.size).toBeGreaterThan(2000);
  });
});

test.describe('png-to-webp: where the browser writes WebP', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await canvasWrites(page, 'image/webp')),
      'this engine\'s canvas hands back a PNG when asked for a WebP; see the refusal below',
    );
  });

  test('lossless means every pixel, and the row says what the bytes are', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [png('diagram.png', encodePng(WIDTH, HEIGHT, busy))]);

    const [made] = await convert(page);
    expect(made.name).toBe('diagram.webp');

    const webp = await openWebp(page, made.bytes);
    const coding = webpFacts(made.bytes).coding;

    if (await canvasWritesLosslessWebp(page)) {
      // This browser writes the lossless coding when asked for it properly,
      // so a lossy file here is the page not asking - whatever the row says
      // about whose fault it was.
      expect(coding, 'the browser can write lossless WebP and the tool did not get one').toBe('VP8L');
      expect(made.says).toContain(await sentence(page, 'result.lossless'));
      const difference = compare(webp, busy);
      expect(difference.solid, `a "lossless" WebP changed ${difference.solid} pixels: ${difference.first}`)
        .toBe(0);
    } else {
      // The engine does not switch codings at 1.0. Not the site's doing - but
      // then the site has to say so, which is what its readback is for.
      test.info().annotations.push({
        type: 'engine',
        description: `asked for lossless, and this browser's canvas writes ${coding} at quality 1`,
      });
      expect(coding).not.toBe('VP8L');
      expect(made.says).toContain(await sentence(page, 'result.askedlossless'));
      expect(made.says).not.toContain(await sentence(page, 'result.lossless'));
    }
  });

  test('"smaller" is the lossy coding, says so, and is still the picture', async ({ page }) => {
    // Also the control for the test above: the same comparison, on the same
    // picture, finding differences - so a zero up there is a measurement and
    // not a comparison that cannot fail.
    await page.goto(URL_PATH);
    await give(page, [png('photo.png', encodePng(WIDTH, HEIGHT, busy))]);

    await expect(page.locator('#quality-field')).toBeHidden();
    await page.locator('input[name="mode"][value="lossy"]').check();
    await expect(page.locator('#quality-field')).toBeVisible();
    await page.locator('#quality').fill('60');

    const [made] = await convert(page);
    expect(webpFacts(made.bytes).coding).toBe('VP8 ');
    expect(made.says).toContain(await sentence(page, 'result.lossy', { quality: 60 }));
    expect(made.says).not.toContain(await sentence(page, 'result.lossless'));

    const difference = compare(await openWebp(page, made.bytes), busy);
    expect(difference.solid, 'a lossy WebP came back identical to the PNG').toBeGreaterThan(0);
  });

  test('the see-through parts come across: alpha exact, solid pixels exact', async ({ page }) => {
    await page.goto(URL_PATH);
    await give(page, [png('logo.png', encodePng(WIDTH, HEIGHT, fading))]);

    await expect(page.locator('#file-list li')).toContainText(await sentence(page, 'file.alpha'));

    const [made] = await convert(page);
    const difference = compare(await openWebp(page, made.bytes), fading);
    expect(difference.alpha, 'the alpha channel changed').toBe(0);

    expect(made.says).toContain(await sentence(page, 'result.alpha'));
    if (await canvasWritesLosslessWebp(page)) {
      expect(webpFacts(made.bytes).coding).toBe('VP8L');
      expect(difference.solid, `solid pixels changed: ${difference.first}`).toBe(0);
      // The qualified sentence, because this is the file the qualification
      // is about; the unqualified one would be claiming too much.
      expect(made.says).toContain(await sentence(page, 'result.lossless.alpha'));
      expect(made.says).not.toContain(await sentence(page, 'result.lossless'));
    }
  });

  test('an alpha channel that is solid corner to corner is not called see-through', async ({ page }) => {
    // Every PNG written here has an alpha channel, as most PNGs do, and in
    // this one it is 255 throughout. Calling that see-through would qualify a
    // lossless claim that needed no qualifying.
    await page.goto(URL_PATH);
    await give(page, [png('screenshot.png', encodePng(WIDTH, HEIGHT, busy))]);

    await expect(page.locator('#file-list li')).not.toContainText(await sentence(page, 'file.alpha'));
    const [made] = await convert(page);
    expect(made.says).not.toContain(await sentence(page, 'result.alpha'));
  });

  test('a few faint pixels in a large picture still count as see-through', async ({ page }) => {
    // The measured bug in the module's own notes: scaled into a small box to
    // be looked at, a couple of thousand pixels at alpha 215 average back to
    // solid against their neighbours and the picture is reported opaque. The
    // walk is exact now; this is the picture that says it stays that way.
    test.setTimeout(120_000);
    const sparse = encodePng(1280, 960, (x, y) => (
      (x % 24 === 0 && y % 20 === 0) ? [90, 140, 200, 215] : [90, 140, 200, 255]
    ));

    await page.goto(URL_PATH);
    await give(page, [png('poster.png', sparse)]);
    await expect(page.locator('#file-list li')).toContainText(await sentence(page, 'file.alpha'));
  });

  test('a WebP called .png is refused by name rather than converted into itself', async ({ page }) => {
    await page.goto(URL_PATH);
    const already = encodeWebp(16, 16, () => [10, 20, 30, 255]);
    await give(page, [
      png('real.png', encodePng(WIDTH, HEIGHT, busy)),
      png('already.png', already),
    ], 1);

    await expect(page.locator('#load-error')).toContainText(await sentence(page, 'read.notpng', {
      name: 'already.png',
      found: await sentence(page, 'found.webp'),
    }));

    const made = await convert(page);
    expect(made.map((one) => one.name)).toEqual(['real.webp']);
  });

  test('the picture never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = encodePng(WIDTH, HEIGHT, busy);
    await give(page, [png('private.png', bytes)]);
    await convert(page);
    await quiet(page);

    const marker = bytes.toString('base64').slice(400, 480);
    expect(marker.length).toBe(80);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});

test.describe('png-to-webp: where the browser does not', () => {
  test('the page says so and will not write PNGs called .webp', async ({ page }) => {
    // `toBlob` never refuses: asked for a format it cannot write it hands
    // back a PNG. A converter that did not check would fill a folder with
    // PNGs named .webp, which is the one outcome worse than refusing.
    test.skip(
      await canvasWrites(page, 'image/webp'),
      'this engine writes WebP, so there is nothing for the page to refuse',
    );

    await page.goto(URL_PATH);
    await expect(page.locator('#support-error')).toContainText(await sentence(page, 'support.nowebp'));

    await page.locator('#file-input').setInputFiles(png('diagram.png', encodePng(WIDTH, HEIGHT, busy)));
    await expect(page.locator('#file-list li')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator('#run')).toBeDisabled();
  });
});
