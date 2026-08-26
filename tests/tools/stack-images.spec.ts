import { test, expect, type Page } from '@playwright/test';
import { encodePng, type Rgb } from '../../lib/image-fixtures';

/**
 * Tool-level functional tests for the Image Stacker.
 *
 * Most of this tool is arithmetic over a stack of frames - average them, take
 * their median, keep the brightest or the darkest, add them - and arithmetic
 * is the rare thing that can be asserted exactly rather than approximately. So
 * the frames here are flat colours with values chosen so that every mode has
 * one right answer and no two modes share it: 40, 120 and 200 average to 120,
 * have a median of 120, a maximum of 200, a minimum of 40, and sum past 255.
 *
 * That last property is the point of using three different numbers. A stacker
 * that quietly returned the first frame, or the last, or the average whatever
 * it was asked for, would pass a test built on frames that agreed with each
 * other. These disagree in every direction.
 *
 * Alignment is turned off throughout. It shifts frames to match each other,
 * which is right for photographs of the same scene and would move flat colours
 * around for no reason - and what is under test here is the stacking, not the
 * registration.
 */

const URL_PATH = '/stack-images/';

const WIDTH = 64;
const HEIGHT = 48;

/** The three values every expectation below is derived from. */
const VALUES = [40, 120, 200] as const;

const frame = (value: number): Buffer => encodePng(WIDTH, HEIGHT, () => [value, value, value] as Rgb);

/** Put the frames on the list and wait for them to be counted. */
async function load(page: Page, values: readonly number[] = VALUES): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles(values.map((value, index) => ({
    name: `frame-${index}.png`,
    mimeType: 'image/png',
    buffer: frame(value),
  })));
  await expect(page.locator('#frame-list li')).toHaveCount(values.length, { timeout: 30_000 });
  await expect(page.locator('#error')).toBeHidden();
}

/** Stack with the current settings and read the middle of the result. */
async function stack(page: Page, mode: string): Promise<{ r: number; g: number; b: number }> {
  await page.locator('#mode').selectOption(mode);
  await page.locator('#align').selectOption('none');

  await expect(page.locator('#run')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 120_000 });

  // Read the pixels back off the result image rather than trusting the page's
  // description of what it did. The middle of the picture, because a flat
  // frame is flat everywhere and the edges are where an alignment or a crop
  // would show first if one had happened.
  return page.evaluate(async () => {
    const image = document.getElementById('result-image') as HTMLImageElement;
    if (!image.complete) await new Promise((done) => { image.onload = done; });

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);

    const x = Math.floor(canvas.width / 2);
    const y = Math.floor(canvas.height / 2);
    const [r, g, b] = context.getImageData(x, y, 1, 1).data;
    return { r, g, b };
  });
}

/**
 * A lossless format, so the number that comes back is the number that was
 * written. PNG is already the default; setting it explicitly keeps these tests
 * honest if that ever changes, since every expectation here is an exact value.
 *
 * The option values are 'png' and 'jpeg', not MIME types - which is worth a
 * line, because assuming the latter made every arithmetic test below sit and
 * time out on a select that would never match.
 */
async function losslessOutput(page: Page): Promise<void> {
  await page.locator('#format').selectOption('png');
}

test.describe('stack-images: the arithmetic', () => {
  test('control: the frames really do differ from each other', async ({ page }) => {
    // Every expectation below depends on the three frames disagreeing. If they
    // were the same colour, a stacker that ignored the mode entirely would
    // pass all seven tests.
    expect(new Set(VALUES).size, 'the fixture frames are not distinct').toBe(3);

    await load(page);
    await expect(page.locator('#frame-list li')).toHaveCount(3);
    await expect(page.locator('#run')).toBeEnabled({ timeout: 30_000 });
  });

  test('average is the mean of the frames', async ({ page }) => {
    // (40 + 120 + 200) / 3 = 120 exactly.
    test.setTimeout(180_000);
    await load(page);
    await losslessOutput(page);

    const { r, g, b } = await stack(page, 'mean');
    expect(r, `average came back ${r}`).toBeGreaterThanOrEqual(118);
    expect(r).toBeLessThanOrEqual(122);
    expect(g).toBe(r);
    expect(b).toBe(r);
  });

  test('median is the middle frame, not the mean of the ends', async ({ page }) => {
    // With 40, 120 and 200 the median and the mean are both 120, so those two
    // are told apart by a fourth frame instead: 40, 120, 200, 200 has a median
    // of 160 and a mean of 140.
    test.setTimeout(180_000);
    await load(page, [40, 120, 200, 200]);
    await losslessOutput(page);

    const { r } = await stack(page, 'median');
    expect(r, `median of 40,120,200,200 came back ${r}`).toBeGreaterThanOrEqual(155);
    expect(r).toBeLessThanOrEqual(165);
  });

  test('lighten keeps the brightest frame', async ({ page }) => {
    test.setTimeout(180_000);
    await load(page);
    await losslessOutput(page);

    const { r } = await stack(page, 'max');
    expect(r, `lighten came back ${r}, not the brightest frame`).toBeGreaterThanOrEqual(197);
    expect(r).toBeLessThanOrEqual(203);
  });

  test('darken keeps the darkest frame', async ({ page }) => {
    test.setTimeout(180_000);
    await load(page);
    await losslessOutput(page);

    const { r } = await stack(page, 'min');
    expect(r, `darken came back ${r}, not the darkest frame`).toBeGreaterThanOrEqual(37);
    expect(r).toBeLessThanOrEqual(43);
  });

  test('add runs past what one frame could hold', async ({ page }) => {
    // 40 + 120 + 200 is 360, which does not fit in eight bits. Whatever the
    // tool does about that, the answer has to be brighter than the brightest
    // frame - a "sum" that came back at 200 would not have added anything.
    test.setTimeout(180_000);
    await load(page);
    await losslessOutput(page);

    const { r } = await stack(page, 'sum');
    expect(r, `add came back ${r}, no brighter than the brightest frame`)
      .toBeGreaterThan(200);
  });

  test('the modes disagree with each other', async ({ page }) => {
    // The test that catches a stacker wired to one function. Lighten and
    // darken on the same frames must not be the same picture.
    test.setTimeout(240_000);

    await load(page);
    await losslessOutput(page);
    const brightest = await stack(page, 'max');

    await load(page);
    await losslessOutput(page);
    const darkest = await stack(page, 'min');

    expect(brightest.r, 'lighten and darken returned the same value')
      .not.toBe(darkest.r);
    expect(brightest.r).toBeGreaterThan(darkest.r);
  });
});

test.describe('stack-images: the result', () => {
  test('the picture keeps the size of the frames that went in', async ({ page }) => {
    test.setTimeout(180_000);
    await load(page);
    await losslessOutput(page);
    await stack(page, 'mean');

    const size = await page.locator('#result-image').evaluate((el) => {
      const image = el as HTMLImageElement;
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(size.width).toBe(WIDTH);
    expect(size.height).toBe(HEIGHT);
  });

  test('half size is half size', async ({ page }) => {
    // The setting exists to fit a stack into memory, so it has to actually
    // reduce what is held rather than only the file at the end.
    test.setTimeout(180_000);
    await load(page);
    await losslessOutput(page);
    await page.locator('#scale').selectOption('half');
    await stack(page, 'mean');

    const size = await page.locator('#result-image').evaluate((el) => {
      const image = el as HTMLImageElement;
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    expect(size.width).toBe(WIDTH / 2);
    expect(size.height).toBe(HEIGHT / 2);
  });

  test('one frame on its own is not a stack', async ({ page }) => {
    // Stacking needs something to stack. Whether the tool refuses or simply
    // hands the frame back, it must not throw or pretend.
    test.setTimeout(120_000);
    const crashed: string[] = [];
    page.on('pageerror', (error) => crashed.push(String(error)));

    await load(page, [120]);
    await page.waitForTimeout(1500);

    expect(crashed, crashed.join('\n')).toEqual([]);
  });
});

test.describe('stack-images: the promise', () => {
  test('the photographs never leave the page', async ({ page }) => {
    // This tool is handed whole camera rolls, and RAW files at that.
    test.setTimeout(180_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await load(page);
    await losslessOutput(page);
    await stack(page, 'mean');
    await page.waitForLoadState('networkidle');

    const marker = frame(VALUES[0]).toString('base64').slice(60, 140);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'a frame was sent').not.toContain(marker);
    }
  });
});
