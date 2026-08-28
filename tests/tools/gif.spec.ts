import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { animationFixture, readGif } from '../../lib/gif';
import { encodePng } from '../../lib/image-fixtures';
import { decodedSize } from '../../lib/browser-image';

/**
 * Tool-level functional tests for the three GIF tools: the maker, the
 * splitter and the analyzer.
 *
 * They are one file because the interesting checks run across them - a GIF
 * built by the maker is taken apart by the splitter and described by the
 * analyzer - and because a GIF's failures are all invisible in a viewer. A
 * browser will happily play an animation whose frame delays are wrong, whose
 * loop count says "once" when it should say "forever", or which has quietly
 * lost a frame; it just plays what it was given.
 *
 * Each tool ships its own gif.js, and two of them their own lzw.js, so none
 * of them is used to check another's arithmetic. lib/gif.ts is a separate
 * implementation - it walks the block structure for the parsing side and does
 * real LZW for the writing side, verified against a browser decoder rather
 * than only against itself.
 */

const MAKER = '/gif-maker/';
const SPLITTER = '/split-gif/';
const ANALYZER = '/gif-analyzer/';

/** A solid-colour PNG, for feeding the maker. */
function framePng(width: number, height: number, rgb: [number, number, number]): Buffer {
  return encodePng(width, height, () => rgb);
}

/** Click a control that saves a file, and return the bytes. */
async function save(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

test.describe('gif-maker: the animation it writes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(MAKER);
  });

  /** Load N solid-colour frames and wait for them to be listed. */
  async function loadFrames(page: Page, colours: Array<[number, number, number]>): Promise<void> {
    await page.locator('#file-input').setInputFiles(colours.map((rgb, index) => ({
      name: `frame-${index}.png`,
      mimeType: 'image/png',
      buffer: framePng(160, 120, rgb),
    })));
    await expect(page.locator('#frame-list li')).toHaveCount(colours.length, { timeout: 30_000 });
    await expect(page.locator('#load-error')).toBeHidden();
  }

  /** Make the GIF and hand back the file. */
  async function makeGif(page: Page): Promise<Buffer> {
    await expect(page.locator('#export')).toBeEnabled({ timeout: 20_000 });
    await page.locator('#export').click();
    await expect(page.locator('#download')).toBeVisible({ timeout: 60_000 });
    return save(page, () => page.locator('#download').click());
  }

  test('every picture given becomes a frame, in order', async ({ page }) => {
    test.setTimeout(120_000);
    await loadFrames(page, [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]);

    const gif = readGif(await makeGif(page));
    expect(gif.version).toMatch(/^GIF8/);
    expect(gif.frames, 'a picture did not become a frame').toHaveLength(4);
  });

  test('the delay asked for is the delay written into the file', async ({ page }) => {
    // GIF stores hundredths of a second, so 0.25 s is 25 and comes back as
    // 250 ms. A viewer plays whatever is in the file without complaint, which
    // is why this is only checkable by reading the bytes.
    test.setTimeout(120_000);
    await loadFrames(page, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);

    await page.locator('#bulk-unit').selectOption('seconds');
    await page.locator('#bulk-amount').fill('0.25');
    await page.locator('#apply-bulk').click();

    const gif = readGif(await makeGif(page));
    for (const [index, frame] of gif.frames.entries()) {
      expect(frame.delayMs, `frame ${index} was written with the wrong delay`).toBe(250);
    }
  });

  test('a frame rate is turned into the right per-frame delay', async ({ page }) => {
    // 10 frames a second is 10 hundredths each. The unit switch is arithmetic
    // the page does on the reader's behalf, and getting it upside down would
    // produce an animation a hundred times too slow.
    test.setTimeout(120_000);
    await loadFrames(page, [[255, 0, 0], [0, 255, 0]]);

    await page.locator('#bulk-unit').selectOption('fps');
    await page.locator('#bulk-amount').fill('10');
    await page.locator('#apply-bulk').click();

    const gif = readGif(await makeGif(page));
    for (const frame of gif.frames) expect(frame.delayMs).toBe(100);
  });

  test('the size chosen is the canvas the file declares', async ({ page }) => {
    // The sources are 640 wide on purpose. The size preset is a ceiling, not a
    // target: given 160 px pictures it leaves them at 160 rather than blowing
    // them up to 320, which is right, and which made the first version of this
    // test assert that a correct tool was wrong.
    test.setTimeout(120_000);
    await page.locator('#file-input').setInputFiles(
      [[255, 0, 0], [0, 255, 0]].map((rgb, index) => ({
        name: `big-${index}.png`,
        mimeType: 'image/png',
        buffer: framePng(640, 480, rgb as [number, number, number]),
      })),
    );
    await expect(page.locator('#frame-list li')).toHaveCount(2, { timeout: 30_000 });

    await page.locator('#size').selectOption('320');

    const gif = readGif(await makeGif(page));
    expect(Math.max(gif.width, gif.height)).toBe(320);
    // Every frame has to fit the canvas it is drawn on.
    for (const frame of gif.frames) {
      expect(frame.left + frame.width).toBeLessThanOrEqual(gif.width);
      expect(frame.top + frame.height).toBeLessThanOrEqual(gif.height);
    }
  });

  test('the GIF it writes is one a browser will play', async ({ page }) => {
    // The end of the line for a format tool: a file that parses but does not
    // decode is not a GIF anybody can use.
    test.setTimeout(120_000);
    await loadFrames(page, [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);

    const bytes = await makeGif(page);
    const size = await decodedSize(page, bytes, 'image/gif');
    expect(size.width, `the GIF did not decode: ${size.error ?? ''}`).toBeGreaterThan(0);
  });

  test('the pictures never leave the page', async ({ page }) => {
    test.setTimeout(120_000);
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const png = framePng(160, 120, [17, 42, 99]);
    await page.locator('#file-input').setInputFiles([{
      name: 'private.png', mimeType: 'image/png', buffer: png,
    }]);
    await expect(page.locator('#frame-list li')).toHaveCount(1, { timeout: 30_000 });
    await makeGif(page);
    await page.waitForLoadState('networkidle');

    const marker = png.toString('base64').slice(60, 140);
    for (const entry of traffic) {
      expect(entry, 'the picture was sent').not.toContain(marker);
    }
  });
});

test.describe('split-gif: taking one apart', () => {
  /** Put a known animation in and wait for its frames. */
  async function loadFixture(page: Page, frames: number): Promise<void> {
    const { bytes } = animationFixture(120, 90, frames, 100);
    await page.goto(SPLITTER);
    await page.locator('#file-input').setInputFiles({
      name: 'animation.gif',
      mimeType: 'image/gif',
      buffer: bytes,
    });
    await expect(page.locator('#frames-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#error')).toBeHidden();
  }

  test('control: the fixture is read as the animation it is', async ({ page }) => {
    // The control for everything below. A fixture the tool could not read
    // would make "no frames came out" look like a splitter bug, and a fixture
    // with the wrong frame count would make a correct splitter look wrong.
    const { bytes } = animationFixture(120, 90, 6, 100);
    expect(readGif(bytes).frames).toHaveLength(6);

    await loadFixture(page, 6);
    await expect(page.locator('#src-frames')).toContainText('6');
    await expect(page.locator('#src-picture')).toContainText('120');
  });

  test('every frame in the file comes out as a picture', async ({ page }) => {
    test.setTimeout(120_000);
    await loadFixture(page, 6);
    await expect(page.locator('#frame-list li, .frame-card, #frames-card li'))
      .toHaveCount(6, { timeout: 30_000 });
  });

  test('a saved frame is a real picture at the animation\'s size', async ({ page }) => {
    test.setTimeout(120_000);
    await loadFixture(page, 4);

    const first = page.locator('#frames-card li').first();
    await expect(first).toBeVisible({ timeout: 30_000 });

    const bytes = await save(page, () => first.getByRole('button', { name: /download/i }).click());
    const size = await decodedSize(page, bytes, 'image/png');

    expect(size.width, `the frame did not decode: ${size.error ?? ''}`).toBe(120);
    expect(size.height).toBe(90);
  });

  test('taking every other frame picks half of them', async ({ page }) => {
    // "Every N" selects rather than discards: all six thumbnails stay on
    // screen and three are marked unpicked, so the reader can see what they
    // are about to leave behind. Counting the rows would find six either way,
    // which is what the first version of this test did.
    test.setTimeout(120_000);
    await loadFixture(page, 6);
    await expect(page.locator('#frames-card li')).toHaveCount(6, { timeout: 30_000 });

    await page.locator('#every').fill('2');
    await page.locator('#every').blur(); // the handler listens for change

    await expect(page.locator('#frames-card li:not(.unpicked)')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator('#frames-card li.unpicked')).toHaveCount(3);
    await expect(page.locator('#download-selected')).toBeVisible();
  });

  test('the animation never leaves the page', async ({ page }) => {
    test.setTimeout(120_000);
    const { bytes } = animationFixture(120, 90, 4, 100);

    await page.goto(SPLITTER);
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await page.locator('#file-input').setInputFiles({
      name: 'private.gif', mimeType: 'image/gif', buffer: bytes,
    });
    await expect(page.locator('#frames-card')).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    const marker = bytes.toString('base64').slice(60, 140);
    for (const entry of traffic) {
      expect(entry, 'the animation was sent').not.toContain(marker);
    }
  });
});

test.describe('gif-analyzer: describing one', () => {
  /** Load a GIF built here and wait for the summary. */
  async function inspect(page: Page, bytes: Buffer): Promise<void> {
    await page.goto(ANALYZER);
    await page.locator('#file-input').setInputFiles({
      name: 'animation.gif',
      mimeType: 'image/gif',
      buffer: bytes,
    });
    await expect(page.locator('#summary-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#load-error')).toBeHidden();
  }

  test('the facts it reports are the facts in the file', async ({ page }) => {
    // Every one of these is checked against lib/gif.ts reading the same bytes,
    // so this is two implementations agreeing rather than one asserting.
    test.setTimeout(120_000);
    const { bytes } = animationFixture(200, 150, 8, 120);
    const expected = readGif(bytes);

    await inspect(page, bytes);

    await expect(page.locator('#fact-version')).toContainText(expected.version.slice(3));
    await expect(page.locator('#fact-canvas')).toContainText('200');
    await expect(page.locator('#fact-canvas')).toContainText('150');
    await expect(page.locator('#fact-frames')).toContainText(String(expected.frames.length));
    await expect(page.locator('#fact-size')).not.toBeEmpty();
  });

  test('a GIF that says it loops forever is reported as looping forever', async ({ page }) => {
    // Loop count zero means forever, and reading it as "no loops" is the
    // classic way to get this backwards.
    test.setTimeout(120_000);
    const { bytes } = animationFixture(80, 60, 3, 100);
    expect(readGif(bytes).loopCount).toBe(0);

    await inspect(page, bytes);
    await expect(page.locator('#fact-loops')).toContainText(/forever|infinite|always|∞/i);
  });

  test('the play time follows from the delays', async ({ page }) => {
    // Eight frames at 120 ms is 0.96 seconds. A tool that reported the stored
    // hundredths as milliseconds would say 96 ms and nothing on screen would
    // look wrong.
    test.setTimeout(120_000);
    const { bytes } = animationFixture(80, 60, 8, 120);
    const total = readGif(bytes).frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    expect(total).toBe(960);

    await inspect(page, bytes);
    await expect(page.locator('#fact-plays')).toContainText(/0\.9|1(\.0)?\s*s/i);
  });

  test('it has something to say about the file', async ({ page }) => {
    test.setTimeout(120_000);
    const { bytes } = animationFixture(200, 150, 12, 40);
    await inspect(page, bytes);

    await expect(page.locator('#findings-card')).toBeVisible();
    await expect(page.locator('#findings li').first()).toBeVisible();
  });

  test('the animation never leaves the page', async ({ page }) => {
    test.setTimeout(120_000);
    const { bytes } = animationFixture(120, 90, 4, 100);

    await page.goto(ANALYZER);
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await page.locator('#file-input').setInputFiles({
      name: 'private.gif', mimeType: 'image/gif', buffer: bytes,
    });
    await expect(page.locator('#summary-card')).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    const marker = bytes.toString('base64').slice(60, 140);
    for (const entry of traffic) {
      expect(entry, 'the animation was sent').not.toContain(marker);
    }
  });
});

test.describe('split-gif: a file it cannot read', () => {
  test('leaves the frames card waiting rather than live and empty', async ({ page }) => {
    // `inert` comes off the last card the moment files are handed over, which
    // is right for a file the tool can read. For one it cannot, the card sat
    // there live and empty: Select all, Select none and Start again all
    // offering to act on no frames, under a line saying the file was not a
    // GIF at all.
    test.setTimeout(120_000);
    const rubbish = Buffer.alloc(4096);
    for (let i = 0; i < rubbish.length; i += 1) rubbish[i] = (i * 37 + 11) & 0xff;

    await page.goto('/split-gif/');
    await page.locator('#file-input').setInputFiles({
      name: 'clip.gif', mimeType: 'image/gif', buffer: rubbish,
    });
    await expect(page.locator('#error')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2000);

    await expect(
      page.locator('#frames-card'),
      'the card came alive over an empty list',
    ).toHaveAttribute('inert', '');
  });

  test('and a real GIF still wakes it', async ({ page }) => {
    // The control. A card that never woke would pass the test above and would
    // have broken the tool for every file it can read.
    test.setTimeout(120_000);
    await page.goto('/split-gif/');
    await page.locator('#file-input').setInputFiles({
      name: 'walk.gif', mimeType: 'image/gif', buffer: animationFixture(32, 24, 3).bytes,
    });
    await expect(page.locator('#frames li')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator('#frames-card')).not.toHaveAttribute('inert', '');
  });
});
