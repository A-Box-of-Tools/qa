import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { encodePng, type Rgb, type Rgba } from '../../lib/image-fixtures';
import { decodedPixels, decodedSize, pixelAt } from '../../lib/browser-image';
import { canvasWrites, sentence, type Given } from '../../lib/converter-frame';
import { discoverTools } from '../../lib/tools';

// The tool and its tests land in different repositories. The checkout for a
// production run decides when these scenarios can exercise a real page.
const SHIPPED = discoverTools().includes('image-layout');
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function png(name: string, width: number, height: number,
  paint: (x: number, y: number) => Rgb | Rgba): Given {
  return { name, mimeType: 'image/png', buffer: encodePng(width, height, paint) };
}

async function load(page: Page, files: Given[]): Promise<void> {
  await page.locator('#file-input').setInputFiles(files);
  await expect(page.locator('#image-list li')).toHaveCount(files.length, { timeout: 30_000 });
  await expect(page.locator('#load-error')).toBeHidden();
  await expect(page.locator('#export')).toBeEnabled();
}

async function spacing(page: Page, width: number, gap = 20, padding = 10): Promise<void> {
  await page.locator('#output-width').fill(String(width));
  await page.locator('#gap').fill(String(gap));
  await page.locator('#padding').fill(String(padding));
}

/** Range controls are edited through the same input event as a dragged thumb. */
async function range(page: Page, id: string, value: number): Promise<void> {
  await expect(page.locator(`#${id}`)).toBeEnabled();
  await page.locator(`#${id}`).evaluate((element, next) => {
    const input = element as HTMLInputElement;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

const bands = (name = 'bands.png', width = 128, height = 128): Given =>
  png(name, width, height, (x) => x < width / 4 ? RED : x < width * 3 / 4 ? GREEN : BLUE);

/** Read the file saved by the browser, so the preview cannot mark its own work. */
async function save(page: Page): Promise<Buffer> {
  await expect(page.locator('#export')).toBeEnabled();
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#export-error')).toBeHidden();
  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await pending;
  const saved = await download.path();
  if (!saved) throw new Error('image-layout saved no file');
  return fs.readFileSync(saved);
}

test.describe('image-layout: the finished image', () => {
  test.skip(!SHIPPED, 'this site does not ship image-layout yet');

  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/image-layout/');
    await page.locator('#format').selectOption('image/png');
  });

  test('image-layout: grid dimensions, gaps and fitting reach the downloaded PNG', async ({ page }) => {
    await load(page, [
      png('wide.png', 64, 32, () => RED),
      png('square.png', 32, 32, () => GREEN),
      png('tall.png', 32, 64, () => BLUE),
    ]);
    await spacing(page, 220);
    await page.locator('#columns').fill('2');
    await page.locator('#ratio').selectOption('square');
    await page.locator('#fit').selectOption('contain');
    const whole = await decodedPixels(page, await save(page));
    expect({ width: whole.width, height: whole.height }).toEqual({ width: 220, height: 220 });
    expect(pixelAt(whole, 55, 55)).toEqual([...RED, 255]);
    expect(pixelAt(whole, 165, 55)).toEqual([...GREEN, 255]);
    expect(pixelAt(whole, 55, 165)).toEqual([...BLUE, 255]);
    // These pixels belong to a letterbox, two gaps, a margin and an empty cell.
    for (const [x, y] of [[55, 15], [110, 55], [55, 110], [5, 55], [165, 165]]) {
      expect(pixelAt(whole, x, y)).toEqual(WHITE);
    }
    await page.locator('#fit').selectOption('cover');
    const filled = await decodedPixels(page, await save(page));
    expect(pixelAt(filled, 55, 15)).toEqual([...RED, 255]);
    expect(pixelAt(filled, 110, 55)).toEqual(WHITE);
  });

  test('image-layout: original strips keep each source shape in both directions', async ({ page }) => {
    await load(page, [png('wide.png', 64, 32, () => RED), png('tall.png', 32, 64, () => GREEN)]);
    await page.locator('#layout').selectOption('horizontal');
    await page.locator('#ratio').selectOption('original');
    await expect(page.locator('#fit')).toBeDisabled();
    await spacing(page, 220);
    const horizontal = await decodedPixels(page, await save(page));
    expect({ width: horizontal.width, height: horizontal.height }).toEqual({ width: 220, height: 92 });
    expect(pixelAt(horizontal, 20, 50)).toEqual([...RED, 255]);
    expect(pixelAt(horizontal, 190, 50)).toEqual([...GREEN, 255]);
    expect(pixelAt(horizontal, 160, 50)).toEqual(WHITE);

    await page.locator('#layout').selectOption('vertical');
    await spacing(page, 120);
    const vertical = await decodedPixels(page, await save(page));
    expect({ width: vertical.width, height: vertical.height }).toEqual({ width: 120, height: 290 });
    expect(pixelAt(vertical, 60, 35)).toEqual([...RED, 255]);
    expect(pixelAt(vertical, 60, 170)).toEqual([...GREEN, 255]);
    expect(pixelAt(vertical, 60, 70)).toEqual(WHITE);
  });

  test('image-layout: PNG preserves source alpha as well as transparent margins', async ({ page }) => {
    await load(page, [png('alpha.png', 64, 64, (x) => x < 32 ? [255, 0, 0, 128] : RED)]);
    await page.locator('#columns').fill('1');
    await spacing(page, 84, 0);
    await page.locator('#transparent').check();
    const output = await decodedPixels(page, await save(page));
    expect({ width: output.width, height: output.height }).toEqual({ width: 84, height: 84 });
    expect(pixelAt(output, 2, 2)[3]).toBe(0);
    expect(pixelAt(output, 20, 40)[3]).toBe(128);
    expect(pixelAt(output, 60, 40)).toEqual([...RED, 255]);
  });

  test('image-layout: JPEG is opaque and uses the chosen background colour', async ({ page }) => {
    test.skip(!(await canvasWrites(page, 'image/jpeg')), 'this browser cannot write JPEG');
    await load(page, [png('transparent.png', 64, 64, () => [0, 0, 0, 0])]);
    await page.locator('#columns').fill('1');
    await spacing(page, 84, 0);
    await page.locator('#transparent').check();
    await page.locator('#format').selectOption('image/jpeg');
    await expect(page.locator('#background')).toBeEnabled();
    await page.locator('#background').evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '#00ff00';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#transparent')).toBeDisabled();
    const bytes = await save(page);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const output = await decodedPixels(page, bytes, 'image/jpeg');
    expect({ width: output.width, height: output.height }).toEqual({ width: 84, height: 84 });
    for (const [x, y] of [[2, 2], [40, 40]]) {
      const [r, g, b, alpha] = pixelAt(output, x, y);
      expect(alpha).toBe(255);
      expect(r).toBeLessThanOrEqual(3);
      expect(g).toBeGreaterThanOrEqual(252);
      expect(b).toBeLessThanOrEqual(3);
    }
  });

  test('image-layout: keyboard reordering invalidates the download and changes its pixels', async ({ page }) => {
    await load(page, [png('red.png', 32, 32, () => RED), png('green.png', 32, 32, () => GREEN)]);
    await page.locator('#layout').selectOption('horizontal');
    await spacing(page, 220);
    const first = await decodedPixels(page, await save(page));
    expect(pixelAt(first, 55, 55)).toEqual([...RED, 255]);
    const move = page.locator('#image-list li').first().getByRole('button', { name: 'Move red.png later', exact: true });
    await move.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#download')).not.toHaveAttribute('href', /.+/);
    await expect(page.locator('#image-list li').first()).toContainText('green.png');
    const reordered = await decodedPixels(page, await save(page));
    expect(pixelAt(reordered, 55, 55)).toEqual([...GREEN, 255]);
    expect(pixelAt(reordered, 165, 55)).toEqual([...RED, 255]);
  });

  test('image-layout: excessive dimensions and consumed space refuse export and recover', async ({ page }) => {
    await load(page, [png('one.png', 32, 32, () => RED), png('two.png', 32, 32, () => GREEN)]);
    await page.locator('#layout').selectOption('vertical');
    await spacing(page, 8192, 0, 0);
    await expect(page.locator('#layout-error')).toHaveText(await sentence(page, 'errorSize'));
    await expect(page.locator('#export')).toBeDisabled();
    await expect(page.locator('#result')).toBeHidden();
    await page.locator('#layout').selectOption('grid');
    await spacing(page, 64, 200, 0);
    await expect(page.locator('#layout-error')).toHaveText(await sentence(page, 'errorSpace'));
    await expect(page.locator('#export')).toBeDisabled();
    await spacing(page, 220);
    await expect(page.locator('#layout-error')).toBeHidden();
    expect(await decodedSize(page, await save(page))).toEqual({ width: 220, height: 110 });
  });

  test('image-layout: a malformed image is reported and a later valid file still works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.locator('#file-input').setInputFiles({
      name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG'),
    });
    await expect(page.locator('#load-error')).toBeVisible();
    await expect(page.locator('#load-error')).toContainText('broken.png');
    await expect(page.locator('#image-list li')).toHaveCount(0);
    await expect(page.locator('#export')).toBeDisabled();
    await load(page, [png('valid.png', 32, 32, () => RED)]);
    await page.locator('#columns').fill('1');
    await spacing(page, 84, 0);
    expect(await decodedSize(page, await save(page))).toEqual({ width: 84, height: 84 });
    expect(errors).toEqual([]);
  });

  test('image-layout: the built-in example previews and downloads four images', async ({ page }) => {
    await page.locator('#example-button').click();
    await expect(page.locator('#image-list li')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('#load-error')).toBeHidden();
    await expect(page.locator('#preview')).toBeVisible({ timeout: 30_000 });
    const bytes = await save(page);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await decodedSize(page, bytes)).toEqual({ width: 1200, height: 1200 });
    await page.locator('#clear-all').click();
    await expect(page.locator('#image-list li')).toHaveCount(0);
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#export')).toBeDisabled();
  });

  test('image-layout: presets apply their settings and manual edits become Custom without losing crops or filenames', async ({ page }) => {
    await load(page, [bands(), png('green.png', 32, 32, () => GREEN)]);
    await page.locator('#frame-select').selectOption({ index: 0 });
    await range(page, 'frame-zoom', 200);
    await range(page, 'frame-pan-x', -40);
    await page.locator('#filename').fill('my collage');
    const presets = [
      { name: 'square', layout: 'grid', columns: '2', width: '1200', ratio: 'square', fit: 'contain', gap: '16', padding: '24', format: 'image/png' },
      { name: 'contact', layout: 'grid', columns: '3', width: '1800', ratio: 'landscape', fit: 'contain', gap: '20', padding: '32', format: 'image/png' },
      { name: 'horizontal', layout: 'horizontal', columns: '1', width: '1600', ratio: 'original', fit: 'contain', gap: '16', padding: '24', format: 'image/png' },
      { name: 'vertical', layout: 'vertical', columns: '1', width: '1200', ratio: 'original', fit: 'contain', gap: '16', padding: '24', format: 'image/png' },
      { name: 'portrait', layout: 'grid', columns: '2', width: '1200', ratio: 'portrait', fit: 'cover', gap: '16', padding: '24', format: 'image/jpeg' },
      { name: 'seamless', layout: 'grid', columns: '2', width: '1200', ratio: 'square', fit: 'cover', gap: '0', padding: '0', format: 'image/jpeg' },
    ];
    for (const preset of presets) {
      await page.locator('#preset').selectOption(preset.name);
      await expect(page.locator('#preset')).toHaveValue(preset.name);
      for (const [id, value] of Object.entries({ layout: preset.layout, columns: preset.columns,
        'output-width': preset.width, ratio: preset.ratio, fit: preset.fit, gap: preset.gap,
        padding: preset.padding, format: preset.format })) {
        await expect(page.locator(`#${id}`)).toHaveValue(value);
      }
      await expect(page.locator('#filename')).toHaveValue('my collage');
      await expect(page.locator('#frame-zoom')).toHaveValue('200');
      await expect(page.locator('#frame-pan-x')).toHaveValue('-40');
    }
    await page.locator('#gap').fill('7');
    await expect(page.locator('#preset')).toHaveValue('custom');
    await expect(page.locator('#gap')).toHaveValue('7');
    await expect(page.locator('#frame-zoom')).toHaveValue('200');
    await expect(page.locator('#filename')).toHaveValue('my collage');
  });

  test('image-layout: zoom and pan belong to a frame through selection, reordering and resets', async ({ page }) => {
    await load(page, [bands(), png('green.png', 32, 32, () => GREEN)]);
    await spacing(page, 220);
    await page.locator('#columns').fill('2');
    await page.locator('#fit').selectOption('contain');
    await page.locator('#frame-select').selectOption({ index: 0 });
    await expect(page.locator('#frame-pan-x')).toBeDisabled();
    const first = await decodedPixels(page, await save(page));
    expect(pixelAt(first, 20, 55)).toEqual([...RED, 255]);
    await range(page, 'frame-zoom', 200);
    await expect(page.locator('#result')).toBeHidden();
    await range(page, 'frame-pan-x', -100);
    const cropped = await decodedPixels(page, await save(page));
    expect(pixelAt(cropped, 20, 55)).toEqual([...GREEN, 255]);
    expect(pixelAt(cropped, 85, 55)).toEqual([...BLUE, 255]);
    expect(pixelAt(cropped, 165, 55)).toEqual([...GREEN, 255]);

    await page.locator('#frame-select').selectOption({ index: 1 });
    await expect(page.locator('#frame-zoom')).toHaveValue('100');
    await expect(page.locator('#frame-pan-x')).toHaveValue('0');
    await page.locator('#image-list li').first().getByRole('button', { name: 'Move bands.png later', exact: true }).click();
    await page.locator('#frame-select').selectOption({ index: 1 });
    await expect(page.locator('#frame-zoom')).toHaveValue('200');
    await expect(page.locator('#frame-pan-x')).toHaveValue('-100');
    const reordered = await decodedPixels(page, await save(page));
    expect(pixelAt(reordered, 55, 55)).toEqual([...GREEN, 255]);
    expect(pixelAt(reordered, 130, 55)).toEqual([...GREEN, 255]);
    expect(pixelAt(reordered, 195, 55)).toEqual([...BLUE, 255]);

    await page.locator('#frame-reset').click();
    await expect(page.locator('#frame-zoom')).toHaveValue('100');
    await expect(page.locator('#frame-pan-x')).toHaveValue('0');
    const reset = await decodedPixels(page, await save(page));
    expect(pixelAt(reset, 130, 55)).toEqual([...RED, 255]);
    expect(pixelAt(reset, 195, 55)).toEqual([...BLUE, 255]);
    await range(page, 'frame-zoom', 200);
    await range(page, 'frame-pan-x', -100);
    await page.locator('#frame-select').selectOption({ index: 0 });
    await range(page, 'frame-zoom', 150);
    await range(page, 'frame-pan-x', 50);
    await page.locator('#frames-reset').click();
    await expect(page.locator('#frame-zoom')).toHaveValue('100');
    await expect(page.locator('#frame-pan-x')).toHaveValue('0');
    await page.locator('#frame-select').selectOption({ index: 1 });
    await expect(page.locator('#frame-zoom')).toHaveValue('100');
    await expect(page.locator('#frame-pan-x')).toHaveValue('0');
    const allReset = await decodedPixels(page, await save(page));
    expect(pixelAt(allReset, 130, 55)).toEqual([...RED, 255]);
    expect(pixelAt(allReset, 55, 55)).toEqual([...GREEN, 255]);
  });

  test('image-layout: dragging a preview frame pans its crop on the available axis', async ({ page }) => {
    await load(page, [bands('wide-bands.png', 128, 64), png('green.png', 32, 32, () => GREEN)]);
    await spacing(page, 220);
    await page.locator('#columns').fill('2');
    await page.locator('#fit').selectOption('cover');
    await page.locator('#frame-select').selectOption({ index: 0 });
    await expect(page.locator('#frame-pan-x')).toBeEnabled();
    await expect(page.locator('#frame-pan-y')).toBeDisabled();
    const centered = await decodedPixels(page, await save(page));
    expect(pixelAt(centered, 20, 55)).toEqual([...GREEN, 255]);
    const selected = await page.locator('#frame-select').inputValue();
    const frame = page.locator(`#frame-layer [data-id="${selected}"]`);
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('aria-pressed', 'true');
    await frame.scrollIntoViewIfNeeded();
    const box = await frame.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error('image-layout has no preview frame to drag');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number(await page.locator('#frame-pan-x').inputValue())).toBeGreaterThan(30);
    await expect(page.locator('#result')).toBeHidden();
    const panned = await decodedPixels(page, await save(page));
    expect(pixelAt(panned, 20, 55)).toEqual([...RED, 255]);
    expect(pixelAt(panned, 165, 55)).toEqual([...GREEN, 255]);
  });
});
