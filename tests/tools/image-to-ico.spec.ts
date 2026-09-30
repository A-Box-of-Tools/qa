import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { realJpeg } from '../../lib/browser-jpeg';
import { quiet } from '../../lib/engine';
import { decodedPixels, decodedSize, pixelAt } from '../../lib/browser-image';
import { encodePng } from '../../lib/image-fixtures';
import { zipEntries } from '../../lib/zip';

/**
 * Tool-level functional tests for Image to Icon.
 *
 * An .ico is not one picture, it is a directory of them, and the failure this
 * tool exists to avoid is shipping a file with fewer sizes in it than the
 * thing reading it asks for - a favicon that is crisp in a bookmark bar and a
 * blurry upscale in the tab strip. Nothing about opening the file shows that;
 * a viewer picks one entry and draws it.
 *
 * So the tests read the .ico's own directory. The format makes that cheap:
 * a six-byte header, then one sixteen-byte entry per image, the first byte of
 * each being its width with zero standing for 256. Parsing it here rather than
 * asking the page keeps the check independent of the code that wrote the file.
 */

const URL_PATH = '/image-to-ico/';

interface IcoEntry {
  width: number;
  height: number;
  bytes: number;
  offset: number;
}

/** The directory of an .ico: what sizes are actually in the file. */
function readIco(file: Buffer): IcoEntry[] {
  expect(file.readUInt16LE(0), 'the reserved field of an .ico must be zero').toBe(0);
  expect(file.readUInt16LE(2), 'the type field of an .ico must be 1').toBe(1);

  const count = file.readUInt16LE(4);
  const out: IcoEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    out.push({
      // Zero means 256: the field is one byte and 256 does not fit in it.
      width: file[at] === 0 ? 256 : file[at],
      height: file[at + 1] === 0 ? 256 : file[at + 1],
      bytes: file.readUInt32LE(at + 8),
      offset: file.readUInt32LE(at + 12),
    });
  }

  return out;
}

async function load(page: Page, bytes: Buffer, name = 'logo.jpg', mimeType = 'image/jpeg'): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType,
    buffer: bytes,
  });
  await expect(page.locator('#file-list li')).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();
}

/** Make the selected outputs and return the requested download. */
async function makeIcon(page: Page, selector = '#result-list a[download$=".ico"]'): Promise<Buffer> {
  await expect(page.locator('#make-icon')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#make-icon').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 60_000 });

  const link = page.locator(selector);
  await expect(link).toBeVisible({ timeout: 30_000 });

  const pending = page.waitForEvent('download');
  await link.click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

/**
 * Tick exactly these sizes.
 *
 * The grid has to be asked for first. Under a named preset the ticks are not
 * decisions - they are the preset's own answer drawn as controls - so the
 * page stopped showing them there and shows them under "choose the sizes
 * yourself", which is the one place they are a question. Before that change
 * this helper could tick a box on a page that was already open; now it says
 * what it wants first, the same way a visitor would.
 */
async function chooseSizes(page: Page, wanted: number[]): Promise<void> {
  const custom = page.locator('input[name="preset"][value="custom"]');
  await custom.check();

  const boxes = page.locator('#size-grid input[type="checkbox"]');
  await expect(boxes.first()).toBeVisible({ timeout: 20_000 });
  const count = await boxes.count();
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    const px = Number(await box.getAttribute('value'));
    if (wanted.includes(px)) await box.check();
    else await box.uncheck();
  }
}

test.describe('image-to-ico: what is actually in the file', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await load(page, await realJpeg(page, 512, 512, 40));
  });

  test('the sizes ticked are the sizes in the directory', async ({ page }) => {
    test.setTimeout(120_000);
    const wanted = [16, 32, 48];
    await chooseSizes(page, wanted);

    const entries = readIco(await makeIcon(page));
    expect(entries.map((e) => e.width).sort((a, b) => a - b)).toEqual(wanted);
    // Square, as an icon has to be.
    for (const entry of entries) expect(entry.height).toBe(entry.width);
  });

  test('256 is stored as the zero the format requires', async ({ page }) => {
    // The one entry that cannot be written literally: the width field is a
    // single byte, so 256 is recorded as 0 and a reader that takes the byte at
    // face value sees a zero-pixel icon.
    test.setTimeout(120_000);
    await chooseSizes(page, [256]);

    const file = await makeIcon(page);
    expect(file[6], 'the width byte for a 256 px entry must be 0').toBe(0);
    expect(file[7], 'the height byte for a 256 px entry must be 0').toBe(0);

    const entries = readIco(file);
    expect(entries).toHaveLength(1);
    expect(entries[0].width).toBe(256);
  });

  test('every entry points at real data inside the file', async ({ page }) => {
    // An offset or length that runs past the end is the way a hand-written
    // container goes wrong, and it produces a file that some readers open and
    // others refuse.
    test.setTimeout(120_000);
    await chooseSizes(page, [16, 32, 64, 128]);

    const file = await makeIcon(page);
    const entries = readIco(file);
    expect(entries.length).toBe(4);

    for (const entry of entries) {
      expect(entry.offset).toBeGreaterThanOrEqual(6 + entries.length * 16);
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.offset + entry.bytes,
        `an entry runs past the end of a ${file.length}-byte file`)
        .toBeLessThanOrEqual(file.length);
    }
  });

  test('a browser can open the icon that comes out', async ({ page }) => {
    test.setTimeout(120_000);
    await chooseSizes(page, [32]);

    const file = await makeIcon(page);
    const decoded = await page.evaluate(async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/x-icon' }));
        return { width: bitmap.width, height: bitmap.height };
      } catch (error) {
        return { width: 0, height: 0, error: String(error) };
      }
    }, file.toString('base64'));

    expect(decoded.width, `the .ico did not decode: ${decoded.error ?? ''}`).toBeGreaterThan(0);
  });
});

test.describe('image-to-ico: the other advertised outputs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    // A visible centre and a clear border distinguish a complete icon from
    // an empty output and let the pack's platform-specific alpha rules show.
    await load(page, encodePng(512, 512, (x, y) => (
      x >= 128 && x < 384 && y >= 128 && y < 384
        ? [255, 0, 0, 255] : [0, 0, 0, 0]
    )), 'logo.png', 'image/png');
  });

  test('the ICNS holds every macOS slot, with a decodable image of its own size', async ({ page }) => {
    test.setTimeout(120_000);
    await page.locator('#want-ico').uncheck();
    await page.locator('#want-icns').check();
    await page.locator('#want-pack').uncheck();
    const file = await makeIcon(page, '#result-list a[download$=".icns"]');

    expect(file.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(file.readUInt32BE(4)).toBe(file.length);
    // These are the platform's slot names, independent of the writer's list.
    const slots: Record<string, number> = {
      icp4: 16, ic11: 32, icp5: 32, ic12: 64, ic07: 128,
      ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024,
    };
    const found: string[] = [];
    let at = 8;
    while (at < file.length) {
      expect(at + 8).toBeLessThanOrEqual(file.length);
      const type = file.subarray(at, at + 4).toString('ascii');
      const length = file.readUInt32BE(at + 4);
      expect(slots, `unrecognised ICNS slot ${type}`).toHaveProperty(type);
      expect(length).toBeGreaterThan(8);
      expect(at + length).toBeLessThanOrEqual(file.length);
      const payload = file.subarray(at + 8, at + length);
      expect(payload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const decoded = await decodedSize(page, payload);
      expect([decoded.width, decoded.height], `${type}: ${decoded.error ?? ''}`)
        .toEqual([slots[type], slots[type]]);
      found.push(type);
      at += length;
    }
    expect(at).toBe(file.length);
    expect(found.sort()).toEqual(Object.keys(slots).sort());
  });

  test('the website ZIP has working manifest references and the required transparency', async ({ page }) => {
    test.setTimeout(120_000);
    await page.locator('input[name="preset"][value="website"]').check();
    await page.locator('#want-ico').check();
    await page.locator('#want-icns').uncheck();
    await page.locator('#want-pack').check();
    await page.locator('#background-mode').selectOption('transparent');

    const entries = zipEntries(await makeIcon(page, '#download-zip'));
    const files = new Map(entries.map((entry) => [entry.name, entry.data]));
    const sizes: Record<string, number> = {
      'favicon-16x16.png': 16,
      'favicon-32x32.png': 32,
      'apple-touch-icon.png': 180,
      'android-chrome-192x192.png': 192,
      'android-chrome-512x512.png': 512,
      'android-chrome-maskable-512x512.png': 512,
      'mstile-150x150.png': 150,
    };
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      ...Object.keys(sizes), 'favicon.ico', 'site.webmanifest',
      'browserconfig.xml', 'head.html', 'README.txt',
    ].sort());
    expect(readIco(files.get('favicon.ico')!).map((entry) => entry.width)).toEqual([16, 32, 48]);

    const opaque = new Set(['apple-touch-icon.png', 'android-chrome-maskable-512x512.png']);
    for (const [name, size] of Object.entries(sizes)) {
      const decoded = await decodedPixels(page, files.get(name)!);
      expect([decoded.width, decoded.height], `${name}: ${decoded.error ?? ''}`).toEqual([size, size]);
      expect(pixelAt(decoded, Math.floor(size / 2), Math.floor(size / 2)), name)
        .toEqual([255, 0, 0, 255]);
      expect(pixelAt(decoded, 0, 0)[3], `${name}: corner alpha`).toBe(opaque.has(name) ? 255 : 0);
      if (opaque.has(name)) {
        expect(decoded.rgba.every((value, index) => index % 4 !== 3 || value === 255),
          `${name} must be opaque at every pixel`).toBe(true);
      }
    }

    const manifest = JSON.parse(files.get('site.webmanifest')!.toString('utf8')) as {
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.icons).toHaveLength(3);
    for (const icon of manifest.icons) {
      const name = icon.src.replace(/^\//, '');
      expect(files.has(name), `${icon.src} has no file in the ZIP`).toBe(true);
      expect(icon.sizes).toBe(`${sizes[name]}x${sizes[name]}`);
      expect(icon.type).toBe('image/png');
    }
    expect(manifest.icons.filter((icon) => icon.purpose === 'maskable').map((icon) => icon.src))
      .toEqual(['/android-chrome-maskable-512x512.png']);
    for (const textName of ['head.html', 'browserconfig.xml']) {
      const references = [...files.get(textName)!.toString('utf8').matchAll(/(?:href|src)="\/([^"#?]+)"/g)];
      expect(references.length, `${textName} names no output files`).toBeGreaterThan(0);
      for (const match of references) expect(files.has(match[1]), `${textName}: ${match[1]}`).toBe(true);
    }
  });
});

test.describe('image-to-ico: the promise', () => {
  test('the picture never leaves the page', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const logo = await realJpeg(page, 512, 512, 41);
    await load(page, logo, 'private.jpg');
    await chooseSizes(page, [32]);
    await makeIcon(page);
    await quiet(page);

    const marker = logo.toString('base64').slice(400, 480);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});
