import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { encodePng } from '../../lib/image-fixtures';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the tracer, added by website #318.
 *
 * A tracer is unusually easy to check and unusually easy to get subtly wrong,
 * which is a good combination for tests. What comes out is an SVG path, and
 * the browser will measure a path for you - so "did it trace the shape that
 * was there" becomes a number rather than a look at a picture.
 *
 * The shapes are therefore chosen for what is known about them before the
 * tool sees them: a disc of a stated radius, a ring with a hole of a stated
 * size, two squares that are definitely two. Every assertion below compares
 * the traced result with the arithmetic of the fixture, never with what the
 * page says it did.
 *
 * WHAT THE README PROMISES, AND WHAT IS HELD TO IT HERE
 *
 *   "a traced circle's radius is within 0.7 px at radius 25 and at radius 200
 *   alike"          - the first test, at a looser two pixels, because the
 *                     failure worth catching is a tracer that lost the shape
 *                     rather than one that rounded differently.
 *
 *   "a shape with forty holes in it is one element and no fill-rule is set
 *   anywhere"       - the ring, sampled through the browser's own renderer.
 *
 *   "past a thousand loops or four hundred kilobytes main.js stops drawing
 *   the result and says what happened"
 *                   - the noise, which is what a photograph looks like to a
 *                     tracer, and the disc as its control.
 */

const URL_PATH = '/image-to-svg/';

/** A black disc of radius `r`, centred on a white square. */
function disc(size: number, r: number): Buffer {
  const middle = size / 2;
  return encodePng(size, size, (x, y) =>
    (((x - middle) ** 2) + ((y - middle) ** 2) <= r * r ? [0, 0, 0] : [255, 255, 255]));
}

/** A black ring: ink between the two radii, paper inside and out. */
function ring(size: number, outer: number, inner: number): Buffer {
  const middle = size / 2;
  return encodePng(size, size, (x, y) => {
    const away = ((x - middle) ** 2) + ((y - middle) ** 2);
    return away <= outer * outer && away >= inner * inner ? [0, 0, 0] : [255, 255, 255];
  });
}

/** Two black squares with white between them. Definitely two shapes. */
function twoSquares(size: number): Buffer {
  return encodePng(size, size, (x, y) => {
    const inLeft = x > 20 && x < 70 && y > 20 && y < 70;
    const inRight = x > 110 && x < 160 && y > 20 && y < 70;
    return inLeft || inRight ? [0, 0, 0] : [255, 255, 255];
  });
}

/**
 * Every pixel its own colour, which is what a photograph is to a tracer.
 *
 * Deterministic rather than random: a fixture that differs between runs is a
 * failure nobody can reproduce. This is dense enough to produce far more than
 * the thousand loops the tool draws the line at.
 */
function noise(size: number): Buffer {
  return encodePng(size, size, (x, y) => {
    const value = ((x * 73) ^ (y * 151)) % 256;
    return [value, value, value];
  });
}

/** Hand the tracer a picture and wait for it to have traced something. */
async function trace(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.locator('#file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
  await expect(page.locator('#load-error')).toBeHidden();
  // #facts is written by the pass that writes the path, so it arriving means
  // there is a result rather than a page part-way through one.
  await expect(page.locator('#facts')).not.toBeEmpty({ timeout: 60_000 });
}

/**
 * The SVG the visitor gets, read off the download itself.
 *
 * Saved rather than fetched from the blob: URL in the page. This tool's
 * Content-Security-Policy has no connect-src for blob:, so a fetch of its own
 * download is refused - correctly, and the first draft of this file spent a
 * run finding that out. Taking the file the way a visitor takes it needs no
 * permission and is the more honest question anyway.
 */
async function tracedSvg(page: Page): Promise<string> {
  await expect(page.locator('#download')).toBeVisible({ timeout: 30_000 });
  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const where = await saved.path();
  if (!where) throw new Error('the browser saved no file');
  return fs.readFileSync(where, 'utf8');
}

/**
 * The bounding box of everything the traced SVG draws, measured by the
 * browser rather than by parsing the path here.
 *
 * getBBox is the browser's own answer about its own geometry, which is what
 * makes it worth asking: a path this repository parsed with a regular
 * expression would be checking the tracer against a second guess at the same
 * thing.
 */
async function drawnBox(page: Page, svg: string): Promise<{ width: number; height: number }> {
  return page.evaluate((source) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-9999px;top:0';
    holder.innerHTML = source;
    document.body.append(holder);
    try {
      const path = holder.querySelector('path');
      if (!path) return { width: 0, height: 0 };
      const box = (path as SVGGraphicsElement).getBBox();
      return { width: box.width, height: box.height };
    } finally {
      holder.remove();
    }
  }, svg);
}

test.describe('image-to-svg: the shape that comes out', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(URL_PATH);
  });

  test('a disc is traced at the size it was drawn', async ({ page }) => {
    await trace(page, 'disc.png', disc(200, 60));

    const box = await drawnBox(page, await tracedSvg(page));
    expect(box.width, `a disc of radius 60 came out ${box.width.toFixed(1)} wide`)
      .toBeCloseTo(120, -0.4);
    expect(box.height).toBeCloseTo(120, -0.4);
    // Round, not merely large: a tracer that returned the whole canvas would
    // pass a size check on its own.
    expect(Math.abs(box.width - box.height), 'the disc came out lopsided')
      .toBeLessThan(3);
  });

  test('control: a smaller disc comes out smaller, by the same factor',
    async ({ page }) => {
      // Without this the test above measures a constant. Half the radius has
      // to be half the drawing, or the number is not coming from the picture.
      await trace(page, 'small.png', disc(200, 30));

      const box = await drawnBox(page, await tracedSvg(page));
      expect(box.width, `a disc of radius 30 came out ${box.width.toFixed(1)} wide`)
        .toBeCloseTo(60, -0.4);
    });

  test('a ring keeps its hole, in one element and with no fill-rule',
    async ({ page }) => {
      await trace(page, 'ring.png', ring(200, 70, 35));
      const svg = await tracedSvg(page);

      // One path for the whole picture, outer loop and hole together. That is
      // the claim the winding rule exists to make good.
      expect((svg.match(/<path/g) ?? []).length,
        'the ring came out as more than one element').toBe(1);
      expect(svg, 'a fill-rule was needed, so the winding is not doing the work')
        .not.toContain('fill-rule');

      // And the hole is a hole. Rendered by the browser and sampled in the
      // middle: ink there would mean the inner loop was traced the same way
      // round as the outer one and filled over it.
      const middleIsPaper = await page.evaluate(async (source) => {
        const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
        try {
          const image = new Image();
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = () => reject(new Error('the traced SVG would not render'));
            image.src = url;
          });
          const canvas = document.createElement('canvas');
          canvas.width = 200;
          canvas.height = 200;
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, 200, 200);
          context.drawImage(image, 0, 0, 200, 200);
          const centre = context.getImageData(100, 100, 1, 1).data;
          const edge = context.getImageData(100, 100 - 52, 1, 1).data;
          return { centre: centre[0], onTheRing: edge[0] };
        } finally {
          URL.revokeObjectURL(url);
        }
      }, svg);

      // The control for the sample: the ring itself has to be inked where it
      // was drawn, or "the middle is white" means only that nothing rendered.
      expect(middleIsPaper.onTheRing, 'nothing was drawn where the ring is')
        .toBeLessThan(128);
      expect(middleIsPaper.centre, 'the hole in the ring was filled in')
        .toBeGreaterThan(200);
    });

  test('two shapes are still one path', async ({ page }) => {
    await trace(page, 'two.png', twoSquares(200));
    const svg = await tracedSvg(page);

    expect((svg.match(/<path/g) ?? []).length).toBe(1);
    // Two shapes rather than one: the page counts them, and two squares with
    // white between them cannot honestly be one.
    await expect(page.locator('#facts')).toContainText('2');
  });
});

test.describe('image-to-svg: what a photograph looks like to a tracer', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(URL_PATH);
  });

  test('noise is called what it is, rather than handed over quietly',
    async ({ page }) => {
      // The tool's own argument, from its README: tracing a photograph
      // "produces thousands of overlapping blobs and a file many times the
      // size of the JPEG, and it looks worse than the JPEG. That is not an
      // implementation that needs improving; it is what tracing is." So the
      // page has to say so.
      await trace(page, 'photo.png', noise(220));

      const said = page.locator('#too-big');
      await expect(
        said,
        'a picture that traced into thousands of shapes was handed over with '
        + 'nothing said about it',
      ).toBeVisible({ timeout: 60_000 });

      // Named as what it is, and not left as a phrase key.
      await expect(said).toContainText(/photograph/i);
      await expect(said).not.toContainText('toobig.');

      // Still the visitor's file to take, which is the other half of the
      // sentence: "The file is still yours to download".
      await expect(page.locator('#download')).toBeVisible();
    });

  test('control: line art is not accused of being a photograph',
    async ({ page }) => {
      await trace(page, 'disc.png', disc(200, 60));
      await expect(
        page.locator('#too-big'),
        'a single disc was called a photograph',
      ).toBeHidden();
    });
});

test.describe('image-to-svg: the promise', () => {
  test('the picture never leaves the page', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const buffer = disc(200, 60);
    await trace(page, 'private.png', buffer);
    await quiet(page);

    const marker = buffer.toString('base64').slice(120, 200);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent somewhere').not.toContain(marker);
      expect(entry, 'the file name was sent somewhere').not.toContain('private.png');
    }
  });
});
