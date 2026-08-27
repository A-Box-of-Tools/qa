import { test, expect, type Page } from '@playwright/test';
import { writeGif, type FixtureGifFrame } from '../../lib/gif';

/**
 * The GIF Splitter's sprite sheet: every kept frame on one PNG, in a grid.
 *
 * Written before the feature shipped, against website PR #198, which states
 * its own rules precisely enough to test:
 *
 *   - the squarest grid that holds the cells - columns is ceil(sqrt(count)),
 *     rows is what is left
 *   - cells are laid row by row, at the GIF's own frame size
 *   - nothing is scaled, because a resampled sheet lays a hairline of the
 *     neighbouring cell down every edge and pixel art is what most of these
 *     GIFs are
 *   - the grid goes in the filename, walk-sheet-6x8.png, because the image
 *     cannot carry it: 48 cells in a 1536x512 sheet could be 6x8 or 12x4
 *   - the frame settings still apply, so keeping fewer frames makes a smaller
 *     sheet
 *
 * THE FIXTURE, AND WHY IT IS NOT THE SHARED ONE
 *
 * lib/gif.ts's animationFixture draws a moving bar across each frame, which
 * is right for a splitter that must not emit the same frame twice but wrong
 * here: to say which cell holds which frame, a cell has to have one colour
 * and no bar wandering through the middle of it. So the frames below are flat
 * and each a different palette entry, which makes the assertion exact - cell
 * k is this colour and no other - rather than approximate.
 *
 * Six frames, deliberately: ceil(sqrt(6)) is 3 and 6/3 is 2, so the grid is
 * 3x2 and neither number is equal to the other or to the frame count. A
 * square count would pass a test that had columns and rows the wrong way
 * round.
 */

const URL_PATH = '/split-gif/';

const W = 40;
const H = 24;
const FRAMES = 6;
const COLUMNS = Math.ceil(Math.sqrt(FRAMES)); // 3
const ROWS = Math.ceil(FRAMES / COLUMNS); // 2

/** Distinct, flat, and in a known order. Index 0 is unused so a blank cell reads as black. */
const PALETTE: Array<[number, number, number]> = [
  [0, 0, 0],
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [255, 0, 255], [0, 255, 255],
];

/** The colour frame n is painted in. */
const colourOf = (n: number): [number, number, number] => PALETTE[(n % (PALETTE.length - 1)) + 1];

function flatGif(count = FRAMES): Buffer {
  const frames: FixtureGifFrame[] = [];
  for (let n = 0; n < count; n += 1) {
    const indices = new Uint8Array(W * H);
    indices.fill((n % (PALETTE.length - 1)) + 1);
    frames.push({ indices, delayMs: 80 });
  }
  return writeGif(W, H, PALETTE, frames);
}

async function load(page: Page, count = FRAMES): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({
    name: 'walk.gif',
    mimeType: 'image/gif',
    buffer: flatGif(count),
  });
  await expect(page.locator('#frames-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#frames li')).toHaveCount(count, { timeout: 30_000 });
}

/** Press the sheet button and hand back the file it produced. */
async function downloadSheet(page: Page): Promise<{ name: string; base64: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.locator('#download-sheet').click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return { name: download.suggestedFilename(), base64: Buffer.concat(chunks).toString('base64') };
}

/**
 * The sheet's real size, and the colour at the middle of each cell.
 *
 * Decoded by the browser rather than by a PNG reader written here: what is
 * being checked is where the tool put things, and the browser is the
 * independent party for that - it did not draw the sheet, it only reads it.
 */
async function readSheet(page: Page, base64: string, cols: number, rows: number) {
  return page.evaluate(async ({ data, cols: c, rows: r, w, h }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);

    const cells: Array<[number, number, number]> = [];
    for (let index = 0; index < c * r; index += 1) {
      const x = (index % c) * w + Math.floor(w / 2);
      const y = Math.floor(index / c) * h + Math.floor(h / 2);
      const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
      cells.push([red, green, blue]);
    }
    return { width: image.naturalWidth, height: image.naturalHeight, cells };
  }, { data: base64, cols, rows, w: W, h: H });
}

test.describe('split-gif: the sprite sheet', () => {
  test('one PNG, the squarest grid, at the frames own size', async ({ page }) => {
    test.setTimeout(180_000);
    await load(page);

    const file = await downloadSheet(page);
    const sheet = await readSheet(page, file.base64, COLUMNS, ROWS);

    // Nothing scaled: the sheet is exactly the grid times the frame, to the
    // pixel. A resampled sheet would be close to this and useless.
    expect(sheet.width, 'the sheet is not columns x frame width').toBe(COLUMNS * W);
    expect(sheet.height, 'the sheet is not rows x frame height').toBe(ROWS * H);
  });

  test('the grid is in the filename, and it is the grid that was drawn', async ({ page }) => {
    // The claim is that the name carries what the image cannot. So the name
    // is not merely checked for a shape - the numbers in it are the ones the
    // picture must actually have.
    test.setTimeout(180_000);
    await load(page);

    const file = await downloadSheet(page);
    const match = file.name.match(/-sheet-(\d+)x(\d+)\.png$/);
    expect(match, `the filename does not carry the grid: ${file.name}`).not.toBeNull();

    const [, cols, rows] = match!.map(Number) as [number, number, number];
    expect(cols).toBe(COLUMNS);
    expect(rows).toBe(ROWS);

    const sheet = await readSheet(page, file.base64, cols, rows);
    expect(sheet.width, 'the filename says a wider grid than the sheet holds').toBe(cols * W);
    expect(sheet.height, 'the filename says a taller grid than the sheet holds').toBe(rows * H);
  });

  test('each cell holds its own frame, in order, row by row', async ({ page }) => {
    // The assertion the flat fixture exists for. A sheet that drew the first
    // frame into every cell, or filled the grid down its columns instead of
    // across its rows, is the wrong sheet and has the right dimensions.
    test.setTimeout(180_000);
    await load(page);

    const file = await downloadSheet(page);
    const sheet = await readSheet(page, file.base64, COLUMNS, ROWS);

    for (let n = 0; n < FRAMES; n += 1) {
      const [red, green, blue] = sheet.cells[n];
      const want = colourOf(n);
      expect(
        [red, green, blue],
        `cell ${n} (row ${Math.floor(n / COLUMNS)}, column ${n % COLUMNS}) holds `
        + `rgb(${red},${green},${blue}) where frame ${n} is rgb(${want.join(',')})`,
      ).toEqual(want);
    }

    // The frames really were different from each other, so the check above
    // could have failed.
    const distinct = new Set(sheet.cells.slice(0, FRAMES).map((cell) => cell.join(',')));
    expect(distinct.size, 'the fixture frames were not distinct').toBe(FRAMES);
  });

  test('keeping fewer frames makes a smaller sheet', async ({ page }) => {
    // "The frame settings still apply - keep every fifth frame and the sheet
    // has a fifth as many cells." Tested by unticking rather than by a
    // setting, because the checkboxes are the plainest version of the same
    // rule.
    test.setTimeout(180_000);
    await load(page);

    await page.locator('#select-none').click();
    for (const index of [0, 1, 2]) {
      await page.locator('#frames li input[type="checkbox"]').nth(index).check();
    }

    const file = await downloadSheet(page);
    // Three cells: ceil(sqrt(3)) is 2 columns, so 2 rows.
    expect(file.name).toMatch(/-sheet-2x2\.png$/);

    const sheet = await readSheet(page, file.base64, 2, 2);
    expect(sheet.width).toBe(2 * W);
    expect(sheet.height).toBe(2 * H);

    // And the three kept frames are the ones in it, in order.
    for (let n = 0; n < 3; n += 1) {
      expect(sheet.cells[n], `cell ${n} is not frame ${n}`).toEqual(colourOf(n));
    }
  });
});
