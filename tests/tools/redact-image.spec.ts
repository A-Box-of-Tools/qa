import { test, expect, type Page } from '@playwright/test';
import { redactionFixture, type Rect, type Rgb } from '../../lib/image-fixtures';

/**
 * Tool-level functional tests for the Image Redactor.
 *
 * This tool's README opens by naming the failure it exists to prevent: a
 * rectangle drawn in a PDF reader or a layered editor is an object saved
 * beside the page rather than into it, and opening the file elsewhere puts
 * back what it covered - a failure that "has published court filings,
 * government reports and newspaper scans". Its own claim is the opposite:
 * "there is no rectangle in the output at all - there are pixel values,
 * written over the ones that were there".
 *
 * That is falsifiable, and it is what these tests are for. A picture is built
 * with a block of a colour that appears nowhere else, redacted, and the file
 * that comes back is decoded and counted: if a single pixel of that colour
 * survives, the promise is broken. The quiet, catastrophic failure mode -
 * redacting the scaled preview instead of the picture - is covered by the
 * same check, since the fixture is far larger than the stage it is drawn on.
 */

const URL_PATH = '/redact-image/';

// Comfortably larger than the on-screen stage, so the preview is a scaled
// copy and any confusion between the two shows up as a wrong output size.
const WIDTH = 1200;
const HEIGHT = 900;

const BACKGROUND: Rgb = [0, 0, 255];
const SECRET: Rgb = [255, 0, 0];
const KEEP: Rgb = [0, 255, 0];

/**
 * Where "Add a box in the middle" puts its box, per main.js: a quarter of the
 * width by a sixth of the height, centred. Recomputed rather than hard-coded
 * so the fixture stays correct if the picture size here changes.
 */
const BOX: Rect = (() => {
  const width = Math.round(WIDTH / 4);
  const height = Math.round(HEIGHT / 6);
  return {
    x: Math.round((WIDTH - width) / 2),
    y: Math.round((HEIGHT - height) / 2),
    width,
    height,
  };
})();

// The secret sits well inside that box, so a rounding difference of a pixel
// at the edges cannot fail the test for a reason that is not the point.
const SECRET_RECT: Rect = {
  x: BOX.x + 50,
  y: BOX.y + 25,
  width: BOX.width - 100,
  height: BOX.height - 50,
};

// Far away from the box, to prove the rest of the picture is left alone.
const KEEP_RECT: Rect = { x: 50, y: 50, width: 100, height: 100 };

const fixture = () => redactionFixture(WIDTH, HEIGHT, SECRET_RECT, KEEP_RECT, {
  background: BACKGROUND,
  secret: SECRET,
  keep: KEEP,
});

/** Hand the tool the fixture and wait for it to be ready to draw on. */
async function loadFixture(page: Page): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: fixture(),
  });
  await expect(page.locator('#edit-controls')).toBeVisible();
  // If the fixture were malformed the tool would say so here instead.
  await expect(page.locator('#load-error')).toBeHidden();
  await expect(page.locator('#loaded-name')).toContainText(`${WIDTH} x ${HEIGHT}`);
}

interface Analysis {
  width: number;
  height: number;
  counts: Record<string, number>;
  boxIsFlat: boolean;
  blocky: boolean;
}

/**
 * Decode the saved file and count colours in it.
 *
 * The result is read off #result-image, whose src is the very blob the
 * Download link points at (asserted in the first test), so this is the output
 * file and not a redraw of the editing canvas. Counting happens in the page
 * and only totals come back: a 1200x900 RGBA buffer is four million numbers
 * and has no business crossing the bridge.
 */
async function analyse(page: Page, box: Rect, named: Record<string, Rgb>): Promise<Analysis> {
  return page.evaluate(async ({ box, named }) => {
    const image = document.getElementById('result-image') as HTMLImageElement;
    if (!image.complete) {
      await new Promise((resolve) => { image.onload = resolve; });
    }

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);

    const counts: Record<string, number> = {};
    for (const name of Object.keys(named)) counts[name] = 0;

    for (let at = 0; at < data.length; at += 4) {
      for (const [name, [r, g, b]] of Object.entries(named)) {
        if (data[at] === r && data[at + 1] === g && data[at + 2] === b) {
          counts[name] += 1;
          break;
        }
      }
    }

    // Is every pixel inside the box the same colour? (What a flat fill means.)
    const first = ((box.y * width) + box.x) * 4;
    const target = [data[first], data[first + 1], data[first + 2]];
    let boxIsFlat = true;
    // And does the box vary in steps rather than per pixel? (What a mosaic means.)
    let neighbourPairs = 0;
    let equalNeighbours = 0;

    for (let y = box.y; y < box.y + box.height; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        const at = ((y * width) + x) * 4;
        if (data[at] !== target[0] || data[at + 1] !== target[1] || data[at + 2] !== target[2]) {
          boxIsFlat = false;
        }
        if (x + 1 < box.x + box.width) {
          neighbourPairs += 1;
          const right = at + 4;
          if (data[at] === data[right]
            && data[at + 1] === data[right + 1]
            && data[at + 2] === data[right + 2]) {
            equalNeighbours += 1;
          }
        }
      }
    }

    return {
      width,
      height,
      counts,
      boxIsFlat,
      // A mosaic repeats a colour across most horizontal neighbours; a
      // photograph's own detail does not.
      blocky: equalNeighbours / Math.max(1, neighbourPairs) > 0.5,
    };
  }, { box, named });
}

/** Redact with the current settings and wait for the file to exist. */
async function save(page: Page): Promise<void> {
  await page.locator('#format').selectOption('png'); // lossless, so counts are exact
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#save').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 20_000 });
}

test.describe('redact-image: the promise', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await loadFixture(page);
  });

  test('control: saving with no boxes leaves the picture alone', async ({ page }) => {
    // This test earns its place twice over. It covers the no-box save path
    // (legitimate: it re-encodes into the chosen format), and it is the
    // control for every "the secret colour is gone" assertion below - it
    // proves the counter can see that colour in this pipeline at all. Without
    // it, a zero could mean the redaction worked or that the analysis was
    // looking in the wrong place, and those are not the same result.
    await save(page);

    const result = await analyse(page, BOX, {
      secret: SECRET,
      keep: KEEP,
      background: BACKGROUND,
    });

    // Half the secret block is the distinctive colour; the other half is the
    // white stripe between.
    const stripes = (SECRET_RECT.width / 2) * SECRET_RECT.height;
    expect(result.counts.secret, 'the counter cannot see the secret colour').toBe(stripes);
    expect(result.counts.keep).toBe(KEEP_RECT.width * KEEP_RECT.height);
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
  });

  test('the redacted pixels are gone from the file, not covered in it', async ({ page }) => {
    await page.locator('#add-box').click();
    await save(page);

    // The thing being analysed is the thing being offered for download.
    const downloadHref = await page.locator('#download').getAttribute('href');
    const shownSrc = await page.locator('#result-image').getAttribute('src');
    expect(downloadHref).toBe(shownSrc);

    const result = await analyse(page, BOX, {
      secret: SECRET,
      keep: KEEP,
      background: BACKGROUND,
      black: [0, 0, 0],
    });

    // The whole point: not one pixel of the hidden colour survives anywhere.
    expect(result.counts.secret, 'the redacted colour survived in the output').toBe(0);

    // The box is one flat colour, edge to edge, and it is black.
    expect(result.boxIsFlat).toBe(true);
    expect(result.counts.black).toBe(BOX.width * BOX.height);

    // And nothing outside the box was touched.
    expect(result.counts.keep).toBe(KEEP_RECT.width * KEEP_RECT.height);
  });

  test('the output is the picture\'s own resolution, not the preview\'s', async ({ page }) => {
    // The stage on screen is a scaled copy; redacting that and saving it would
    // hand back a smaller picture, and would mean the boxes had been applied
    // at the wrong scale.
    const stage = await page.locator('#preview').boundingBox();
    expect(stage!.width, 'the fixture should be larger than the stage').toBeLessThan(WIDTH);

    await page.locator('#add-box').click();
    await save(page);

    const result = await analyse(page, BOX, { secret: SECRET });
    expect(result.width).toBe(WIDTH);
    expect(result.height).toBe(HEIGHT);
    await expect(page.locator('#result-facts')).toContainText(`${WIDTH} x ${HEIGHT}`);
  });

  test('two boxes both land, and both destroy what was under them', async ({ page }) => {
    await page.locator('#add-box').click();
    await page.locator('#add-box').click();
    await expect(page.locator('#region-list li')).toHaveCount(2);

    await save(page);

    const result = await analyse(page, BOX, { secret: SECRET, black: [0, 0, 0] });
    expect(result.counts.secret).toBe(0);
  });
});

test.describe('redact-image: the softer styles, and what the page says about them', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await loadFixture(page);
  });

  test('a mosaic leaves blocks, and the page admits what it left', async ({ page }) => {
    await page.locator('#add-box').click();
    await page.locator('input[name="style"][value="pixelate"]').check();

    // The honesty claim: fill says nothing, pixelate and blur must say what
    // they leave behind, in numbers rather than an adjective.
    const risk = page.locator('#risk-note');
    await expect(risk).toBeVisible();
    await expect(risk).toContainText(/blocks of \d+ px/);
    await expect(risk).toContainText(/averages of what was underneath/);

    await save(page);

    const result = await analyse(page, BOX, { secret: SECRET });

    // The fine detail is gone: one-pixel stripes have become blocks, so
    // horizontal neighbours now mostly match where before none did.
    expect(result.blocky, 'a mosaic should flatten the stripes into blocks').toBe(true);
    // But it is a grid of averages, not one flat colour - which is the whole
    // difference between this and a fill.
    expect(result.boxIsFlat).toBe(false);

    // Deliberately NOT asserted: that the secret colour is gone. A mosaic
    // keeps one average per block, so a large enough patch of a colour comes
    // back as that colour - which is exactly the leak the note above warns
    // about, and why the README calls this style unfinished and makes black
    // fill the default. Asserting zero here would be asserting a guarantee
    // the tool is careful never to make.
  });

  test('a blur warns too, and blurs rather than flattening', async ({ page }) => {
    await page.locator('#add-box').click();
    await page.locator('input[name="style"][value="blur"]').check();

    await expect(page.locator('#risk-note')).toBeVisible();

    await save(page);
    const result = await analyse(page, BOX, { secret: SECRET });
    // Same reasoning as the mosaic: a convolution is a weighted average, so
    // the honest check is that the stripes were smeared, not that the colour
    // was erased.
    expect(result.boxIsFlat).toBe(false);
    expect(result.counts.secret, 'the stripes should have been smeared')
      .toBeLessThan(SECRET_RECT.width * SECRET_RECT.height / 2);
  });

  test('a plain black fill says nothing, because it has nothing to admit', async ({ page }) => {
    await page.locator('#add-box').click();
    await page.locator('input[name="style"][value="fill"]').check();
    await expect(page.locator('#risk-note')).toBeHidden();
  });
});

test.describe('redact-image: the editing controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await loadFixture(page);
  });

  test('saving is offered as soon as there is a picture', async ({ page }) => {
    // Saving is gated on having a picture, not on having drawn a box
    // (main.js: `save.disabled = !picture || busy`). Zero boxes is a
    // legitimate request - it re-encodes into the chosen format - so the
    // button stays live, and the undo controls are the ones that track boxes.
    await expect(page.locator('#save')).toBeEnabled();
    await expect(page.locator('#undo')).toBeDisabled();
    await expect(page.locator('#clear-boxes')).toBeDisabled();

    await page.locator('#add-box').click();
    await expect(page.locator('#undo')).toBeEnabled();
    await expect(page.locator('#clear-boxes')).toBeEnabled();
  });

  test('undo takes back one box, and "remove every box" takes back all of them', async ({ page }) => {
    for (let i = 0; i < 3; i += 1) await page.locator('#add-box').click();
    await expect(page.locator('#region-list li')).toHaveCount(3);

    await page.locator('#undo').click();
    await expect(page.locator('#region-list li')).toHaveCount(2);

    await page.locator('#clear-boxes').click();
    await expect(page.locator('#region-list li')).toHaveCount(0);
    await expect(page.locator('#clear-boxes')).toBeDisabled();
  });

  test('choosing a different picture clears the boxes drawn on the last one', async ({ page }) => {
    // Boxes are positions in a specific picture; carrying them over to the
    // next one would put them somewhere nobody asked for.
    await page.locator('#add-box').click();
    await expect(page.locator('#region-list li')).toHaveCount(1);

    await page.locator('#clear-image').click();
    await loadFixture(page);

    await expect(page.locator('#region-list li')).toHaveCount(0);
    await expect(page.locator('#clear-boxes')).toBeDisabled();
  });

  test('the picture never leaves the page', async ({ page }) => {
    // Same promise as every tool here, and the one worth checking on a tool
    // people hand sensitive documents to.
    const traffic: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.url().length > 500) {
        traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 2000)}`);
      }
    });

    await page.locator('#add-box').click();
    await save(page);
    await page.waitForLoadState('networkidle');

    // Nothing should be carrying image data off the page; a picture leaving
    // would mean a large body or a very long URL going somewhere.
    const suspicious = traffic.filter((entry) => entry.includes('image/')
      || /base64|iVBORw0/.test(entry));
    expect(suspicious, 'something that looks like image data was sent').toEqual([]);
  });
});
