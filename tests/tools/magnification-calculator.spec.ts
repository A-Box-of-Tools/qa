import { test, expect, type Page } from '@playwright/test';
import { quiet } from '../../lib/engine';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the magnification calculator.
 *
 * The page takes the numbers printed on a telescope, a pair of binoculars, a
 * microscope or a magnifying glass and makes three kinds of claim about them.
 * A sum: 1200 mm over a 25 mm eyepiece is 48 times. A judgement: past twice
 * its aperture in millimetres a telescope has nothing more to show, however
 * large the number. And a picture: three drawings said to share one scale of
 * angle, so that a thing drawn twice as wide is being claimed to look twice as
 * wide.
 *
 * All three fail silently. A wrong quotient is still a number, a verdict on the
 * wrong side of its limit still reads as advice, and a Moon at the wrong scale
 * is still a convincing Moon. So each is checked against arithmetic done in
 * this file, from the rules the page itself cites, and never against the
 * page's account of what it did.
 *
 * WHERE THE PICTURE IS READ
 *
 * Off the canvas. The Moon is a bright disc on a dark sky, so along a
 * picture's middle row its width is the distance between the two places the
 * light crosses half its peak, found to a fraction of a pixel. Outside the
 * circle an eyepiece shows, the canvas is black, so the circle's width is how
 * far the row runs from the Moon before it turns black. Nothing is asked of a
 * caption.
 *
 * Every expectation about a picture is a ratio between two measurements, so
 * none of them knows how many pixels the page gives a degree. That is the
 * page's to choose and to change.
 *
 * WHAT IS NOT ASSERTED
 *
 * Sentences. A verdict is read from which entry of the dial's legend is marked
 * current, counted from the low end; a number from the first number in its
 * place on the page. A change of wording on the site should not fail this
 * file, and a change of arithmetic should.
 */

const URL_PATH = '/magnification-calculator/';

const SHIPPED = discoverTools().includes('magnification-calculator');
const NOT_YET = 'this site does not ship magnification-calculator yet';

// Nothing here is slow: the page answers inside the event that changed a box.
// The allowance is for WebKit on a runner with three other workers on it,
// where a case that takes three seconds at a desk has taken thirty.
test.beforeEach(() => {
  test.setTimeout(120_000);
});

/** The Moon's width in the sky, in degrees: its diameter over its mean distance. */
const MOON_DEGREES = ((2 * 1737.4) / 384_400) * (180 / Math.PI);

type Instrument = 'telescope' | 'binoculars' | 'microscope' | 'magnifier';

/**
 * Wait for the page to have started. The markup arrives before the modules
 * have run, and the tool takes this warning away only once its listeners are
 * attached, which is also when it writes its first answer. It is ten modules,
 * and from a real site on a busy machine a page of that size has taken longer
 * to arrive than an assertion waits for by default.
 */
async function started(page: Page): Promise<void> {
  await expect(page.locator('#boot-warning'), 'the page never finished starting')
    .toHaveCount(0, { timeout: 45_000 });
}

/** Open the page and wait for it to have worked something out. */
async function open(page: Page): Promise<void> {
  await page.goto(URL_PATH);
  await started(page);
  await expect(page.locator('#power'), 'the page opened without an answer').not.toBeEmpty();
}

/** Press a tab or a chip. Each is a label around a radio button nobody sees. */
async function choose(page: Page, group: string, value: string): Promise<void> {
  await page.locator(`label:has(input[name="${group}"][value="${value}"])`).click();
  await expect(page.locator(`input[name="${group}"][value="${value}"]`)).toBeChecked();
}

async function instrument(page: Page, name: Instrument): Promise<void> {
  await choose(page, 'world', name);
  await expect(page.locator('#main')).toHaveAttribute('data-world', name);
}

/** Type into boxes by id, in the order given. */
async function type(page: Page, boxes: Record<string, string>): Promise<void> {
  for (const [id, value] of Object.entries(boxes)) {
    await page.locator(`#${id}`).fill(value);
  }
}

/**
 * Change one of the page's assumptions. They sit in a section that starts
 * closed, and a menu inside a closed section is not there to be used.
 */
async function assume(page: Page, id: string, value: string): Promise<void> {
  const section = page.locator('#assumptions');
  if (!await section.evaluate((node) => (node as HTMLDetailsElement).open)) {
    await section.locator('summary').click();
  }
  await page.locator(`#${id}`).selectOption(value);
}

/** Every number an element shows, in order: [7.5, 131, 1000, 393, 1000]. */
async function numbers(page: Page, selector: string): Promise<number[]> {
  const text = ((await page.locator(selector).textContent()) ?? '').replace(/,/g, '');
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** The first number an element shows: 70 from "70×", 5.25 from "5.25 mm". */
async function shown(page: Page, selector: string): Promise<number> {
  const [first] = await numbers(page, selector);
  if (first === undefined) {
    throw new Error(`${selector} shows no number: "${await page.locator(selector).textContent()}"`);
  }
  return first;
}

/** The magnification the page says it is working at. */
const power = (page: Page) => shown(page, '#power');

/**
 * Which zone of the dial the page puts this magnification in, counted from
 * the low end, and out of how many. The last is always the one past which a
 * bigger number shows nothing new.
 */
async function zone(page: Page): Promise<{ at: number; of: number }> {
  return page.evaluate(() => {
    const entries = Array.from(document.querySelectorAll('#dial-legend li'));
    return {
      at: entries.findIndex((entry) => entry.getAttribute('aria-current') === 'true'),
      of: entries.length,
    };
  });
}

type Picture = 'view' | 'close' | 'bare';

/**
 * What a picture of the Moon has on its middle row, in CSS pixels: the width
 * of the bright disc, and the width of the lit circle it sits in.
 */
async function drawn(page: Page, picture: Picture): Promise<{ disc: number; circle: number }> {
  return page.evaluate((id) => {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    const { width, height } = canvas;
    if (!width || !height) throw new Error(`#${id} has no size yet`);
    const row = canvas.getContext('2d')!.getImageData(0, Math.floor(height / 2), width, 1).data;
    const light: number[] = [];
    for (let at = 0; at < width; at += 1) {
      light.push(0.2126 * row[at * 4] + 0.7152 * row[at * 4 + 1] + 0.0722 * row[at * 4 + 2]);
    }
    const peak = Math.max(...light);
    if (peak < 40) throw new Error(`#${id} has nothing bright on its middle row`);
    const half = peak / 2;
    const first = light.findIndex((value) => value >= half);
    let last = width - 1;
    while (light[last] < half) last -= 1;
    // Where the light crosses half its peak, between one pixel and the next. A
    // disc that runs off the picture ends at the picture's edge.
    const left = first === 0
      ? 0
      : first - 0.5 + (half - light[first - 1]) / (light[first] - light[first - 1]);
    const right = last === width - 1
      ? width
      : last + 1.5 - (half - light[last + 1]) / (light[last] - light[last + 1]);
    // The circle is walked outwards from the brightest pixel until the row
    // turns black. Counting in from the two ends of the row instead met a
    // sliver a third of a pixel wide down the canvas's own right-hand edge,
    // which WebKit at a phone's three device pixels leaves faintly lit, and
    // took it for the far side of the circle.
    let from = light.indexOf(peak);
    let to = from;
    while (from > 0 && light[from - 1] > 3) from -= 1;
    while (to < width - 1 && light[to + 1] > 3) to += 1;
    const scale = canvas.getBoundingClientRect().width / width;
    return { disc: (right - left) * scale, circle: (to - from + 1) * scale };
  }, picture);
}

/** How light a picture is, from 0 to 255, averaged along its middle row. */
async function lightOf(page: Page, picture: Picture): Promise<number> {
  return page.evaluate((id) => {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    const { width, height } = canvas;
    if (!width || !height) throw new Error(`#${id} has no size yet`);
    const row = canvas.getContext('2d')!.getImageData(0, Math.floor(height / 2), width, 1).data;
    let sum = 0;
    for (let at = 0; at < width; at += 1) {
      sum += 0.2126 * row[at * 4] + 0.7152 * row[at * 4 + 1] + 0.0722 * row[at * 4 + 2];
    }
    return sum / width;
  }, picture);
}

/** How far a measured ratio is from the one expected, as a fraction of it. */
const off = (measured: number, expected: number) => Math.abs(measured / expected - 1);

test.describe('magnification-calculator: the sums', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('a telescope magnifies by its focal length over the eyepiece\'s, whatever its aperture',
    async ({ page }) => {
      await type(page, { 'tel-aperture': '96', 'tel-focal': '1200', 'tel-eyepiece': '25' });
      await expect.poll(() => power(page)).toBe(1200 / 25);
      // The beam leaving the eyepiece is the aperture over the magnification.
      expect(await shown(page, '#tel-s-pupil')).toBeCloseTo(96 / 48, 2);

      await page.locator('#tel-barlow').selectOption('2');
      await expect.poll(() => power(page), { message: 'a 2x Barlow did not double it' }).toBe(96);
      await page.locator('#tel-barlow').selectOption('1');

      // The control, and the point of the page: twice the aperture is not one
      // more times of magnification. A calculator that let the aperture into
      // the quotient would pass everything above with one telescope. It is
      // asked at 9.6 times because the readout drops its decimals above
      // twenty, and a small leak would hide in the rounding of 48.
      await type(page, { 'tel-focal': '480', 'tel-eyepiece': '50' });
      await expect.poll(() => power(page)).toBeCloseTo(480 / 50, 2);
      expect(await shown(page, '#tel-s-pupil')).toBeCloseTo(96 / 9.6, 1);
      await type(page, { 'tel-aperture': '192' });
      await expect.poll(() => shown(page, '#tel-s-pupil')).toBeCloseTo(192 / 9.6, 1);
      expect(await power(page), 'a wider telescope was given a different magnification')
        .toBeCloseTo(480 / 50, 2);

      // Numbers that divide into nothing tidy: 650 over 9 is 72.2, written
      // without the decimal, and 650 over 130 is the focal ratio.
      await type(page, { 'tel-aperture': '130', 'tel-focal': '650', 'tel-eyepiece': '9' });
      await expect.poll(async () => Math.abs((await power(page)) - 650 / 9)).toBeLessThanOrEqual(0.5);
      expect(await shown(page, '#tel-s-pupil')).toBeCloseTo(130 / (650 / 9), 1);
      expect(await shown(page, '#tel-s-ratio')).toBe(650 / 130);
    });

  test('binoculars: the first number magnifies, and the second over the first is the beam',
    async ({ page }) => {
      await instrument(page, 'binoculars');
      await type(page, { 'bin-power': '8', 'bin-objective': '42' });
      await expect.poll(() => power(page)).toBe(8);
      expect(await shown(page, '#bin-s-pupil')).toBeCloseTo(42 / 8, 2);

      await type(page, { 'bin-power': '10', 'bin-objective': '25' });
      await expect.poll(() => power(page)).toBe(10);
      expect(await shown(page, '#bin-s-pupil')).toBeCloseTo(25 / 10, 2);
    });

  test('a field of view printed three ways is one angle', async ({ page }) => {
    // Makers print the same thing as an angle, as metres across at a
    // kilometre, or as feet across at a thousand yards. Seen from the middle,
    // half the width subtends half the angle: 7.5 degrees is 131 m and 393 ft.
    const across = (degrees: number, distance: number) =>
      2 * distance * Math.tan((degrees / 2) * (Math.PI / 180));

    await instrument(page, 'binoculars');
    await type(page, { 'bin-power': '8', 'bin-objective': '42', 'bin-field': '7.5' });
    await expect.poll(() => shown(page, '#bin-s-field')).toBeCloseTo(7.5, 1);
    const stated = await numbers(page, '#bin-s-field');
    for (const [what, width] of [['metres', across(7.5, 1000)], ['feet', across(7.5, 3000)]] as const) {
      expect(stated.some((value) => Math.abs(value - width) <= 0.6),
        `7.5 degrees should be ${width.toFixed(1)} ${what} across; the page says ${stated.join(', ')}`)
        .toBe(true);
    }

    // And back from each. The box holds what is printed and the menu says
    // which of the three it is.
    await page.locator('#bin-field-unit').selectOption('metres');
    await type(page, { 'bin-field': '131' });
    await expect.poll(() => shown(page, '#bin-s-field'),
      { message: '131 m at 1000 m was not read as 7.5 degrees' }).toBeCloseTo(7.5, 1);

    await page.locator('#bin-field-unit').selectOption('feet');
    await type(page, { 'bin-field': '393' });
    await expect.poll(() => shown(page, '#bin-s-field'),
      { message: '393 ft at 1000 yd was not read as 7.5 degrees' }).toBeCloseTo(7.5, 1);
  });

  test('a microscope multiplies its two lenses, and the field number sets the width seen',
    async ({ page }) => {
      await instrument(page, 'microscope');
      await choose(page, 'mic-objective', '40');
      await type(page, { 'mic-eyepiece': '10', 'mic-fn': '18' });
      await expect.poll(() => power(page)).toBe(40 * 10);
      expect(await shown(page, '#mic-s-field')).toBeCloseTo(18 / 40, 2);

      await type(page, { 'mic-fn': '22' });
      await expect.poll(() => shown(page, '#mic-s-field')).toBeCloseTo(22 / 40, 2);

      // The control: a stronger eyepiece raises the total and leaves both the
      // width of specimen seen and the finest detail where they were, because
      // neither belongs to it.
      const detail = await shown(page, '#mic-s-detail');
      await type(page, { 'mic-eyepiece': '15' });
      await expect.poll(() => power(page)).toBe(40 * 15);
      expect(await shown(page, '#mic-s-field'), 'the eyepiece changed the width seen')
        .toBeCloseTo(22 / 40, 2);
      expect(await shown(page, '#mic-s-detail'), 'the eyepiece changed the finest detail')
        .toBe(detail);

      // An objective of one's own. Detail is set by the numerical aperture and
      // nothing else, so twice the aperture separates things half the size.
      await choose(page, 'mic-objective', 'custom');
      await type(page, { 'mic-power': '63', 'mic-na': '1.3' });
      await expect.poll(() => power(page)).toBe(63 * 15);
      expect(await shown(page, '#mic-s-field')).toBeCloseTo(22 / 63, 2);
      expect(off(detail / (await shown(page, '#mic-s-detail')), 1.3 / 0.65),
        'a 1.3 aperture should separate half of what a 0.65 does').toBeLessThan(0.05);
    });

  test('a magnifier\'s power, focal length and diopters are one lens said three ways',
    async ({ page }) => {
      await instrument(page, 'magnifier');
      // A 10x loupe: 250 mm of reading distance over a 25 mm focal length,
      // and 1000 over that focal length in diopters.
      await type(page, { 'mag-value': '10' });
      await expect.poll(() => power(page)).toBe(10);
      expect(await shown(page, '#mag-s-focal')).toBe(250 / 10);
      expect(await shown(page, '#mag-s-diopters')).toBe(1000 / 25);

      // The menu says what the number is. It must not rewrite the number: the
      // box is what the visitor read off the lens, and it travels with a
      // change of language, where a conversion would run a second time.
      await page.locator('#mag-unit').selectOption('focal');
      await expect(page.locator('#mag-value'), 'the menu rewrote what was typed').toHaveValue('10');
      await expect.poll(() => power(page), { message: 'a 10 mm lens is 25 times' }).toBe(250 / 10);
      await type(page, { 'mag-value': '50' });
      await expect.poll(() => power(page)).toBe(250 / 50);

      // Diopters are counted two ways, and the page says which. A reading or
      // lamp magnifier is sold with one added, the eye being focused close: a
      // +20 lens is 6x. A maker who does not add it calls the same lens 5x.
      await page.locator('#mag-unit').selectOption('dioptre');
      await type(page, { 'mag-value': '20' });
      await expect.poll(() => power(page)).toBe(250 / (1000 / 20) + 1);
      await assume(page, 'mag-rule', 'relaxed');
      await expect.poll(() => power(page)).toBe(250 / (1000 / 20));
      await assume(page, 'mag-rule', 'close');
      await expect.poll(() => power(page)).toBe(250 / (1000 / 20) + 1);
    });
});

test.describe('magnification-calculator: where a bigger number stops helping', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('a telescope\'s limit belongs to its aperture, and not to the number', async ({ page }) => {
    // A 70 mm telescope tops out at twice its aperture in millimetres. A 4 mm
    // eyepiece on 700 mm is 175 times, which is past it.
    await type(page, { 'tel-aperture': '70', 'tel-focal': '700', 'tel-eyepiece': '4' });
    await expect.poll(() => power(page)).toBe(175);
    const narrow = await zone(page);
    expect(narrow.at, '175x on 70 mm of aperture was not called empty').toBe(narrow.of - 1);

    // The control. The same eyepiece and the same 175 times on 200 mm of
    // aperture is well inside what that telescope can show. A verdict read
    // off the magnification alone would call both the same.
    await type(page, { 'tel-aperture': '200' });
    await expect.poll(async () => (await zone(page)).at,
      { message: '175x on 200 mm of aperture was still called empty' }).toBeLessThan(narrow.of - 1);
    expect(await power(page)).toBe(175);

    // And the boundary itself. Exactly twice the aperture is the top of the
    // useful range, not the first magnification past it.
    await type(page, { 'tel-aperture': '70', 'tel-eyepiece': '5' });
    await expect.poll(() => power(page)).toBe(140);
    expect((await zone(page)).at, 'exactly twice the aperture was called empty')
      .toBe(narrow.of - 2);
  });

  test('the same 1000x is empty on one objective and useful on another', async ({ page }) => {
    // A microscope's useful top is a thousand times the numerical aperture:
    // 650x for a 40x/0.65, 1250x for a 100x/1.25 in oil.
    await instrument(page, 'microscope');
    await choose(page, 'mic-objective', '40');
    await type(page, { 'mic-eyepiece': '25' });
    await expect.poll(() => power(page)).toBe(1000);
    const dry = await zone(page);
    expect(dry.at, '1000x on a 0.65 aperture was not called empty').toBe(dry.of - 1);

    await choose(page, 'mic-objective', '100');
    await type(page, { 'mic-eyepiece': '10' });
    await expect.poll(async () => (await zone(page)).at,
      { message: '1000x on a 1.25 aperture was called empty' }).toBe(dry.of - 2);
    expect(await power(page), 'the two ways to 1000x are not the same number').toBe(1000);
  });

  test('light the eye cannot take in is called wasted, by the pupil the page is told',
    async ({ page }) => {
      // 1000 mm over a 32 mm eyepiece is 31 times, and 200 mm over that is a
      // beam 6.4 mm wide. Inside a 7 mm pupil it all gets in; a 6 mm pupil
      // loses the edge of it, and the lowest zone of the dial is for that.
      await type(page, { 'tel-aperture': '200', 'tel-focal': '1000', 'tel-eyepiece': '32' });
      await expect.poll(() => shown(page, '#tel-s-pupil')).toBeCloseTo(6.4, 1);
      expect((await zone(page)).at, 'a 6.4 mm beam into a 7 mm pupil was called wasted')
        .toBeGreaterThan(0);

      await assume(page, 'eye-pupil', '6');
      await expect.poll(async () => (await zone(page)).at,
        { message: 'a 6.4 mm beam into a 6 mm pupil was not called wasted' }).toBe(0);
    });

  test('binoculars are judged by the light that reaches the eye, and drawn that way',
    async ({ page }) => {
      // What the eye gets through a beam narrower than its own pupil is the
      // square of the two widths. The page takes the pupil as 5 mm at dusk
      // and says so beside the number.
      const share = (objective: number, magnification: number, pupil: number) =>
        Math.min(1, (objective / magnification / pupil) ** 2) * 100;

      await instrument(page, 'binoculars');
      await type(page, { 'bin-power': '8', 'bin-objective': '21' });

      // By day the pocket pair gives up nothing, which is the control: the
      // dimness below belongs to the light, not to the binoculars.
      await choose(page, 'look-binoculars', 'bird-day');
      await expect.poll(() => shown(page, '#bin-s-light')).toBe(100);

      await choose(page, 'look-binoculars', 'bird-dusk');
      await expect.poll(async () => Math.abs((await shown(page, '#bin-s-light')) - share(21, 8, 5)),
        { message: '8x21 at dusk should pass about 28% of what the eye alone gets' })
        .toBeLessThanOrEqual(1);
      const pocket = await lightOf(page, 'view');
      expect(pocket, 'the dusk view is drawn black, so there is nothing to compare').toBeGreaterThan(1);

      await type(page, { 'bin-objective': '42' });
      await expect.poll(() => shown(page, '#bin-s-light')).toBe(100);
      // The picture has to agree with the number beside it.
      await expect.poll(() => lightOf(page, 'view'),
        { message: 'the 8x42 view at dusk is drawn no brighter than the 8x21' })
        .toBeGreaterThan(pocket * 1.2);
    });
});

test.describe('magnification-calculator: the pictures, which claim one scale', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    // The page eases a change of magnification over a third of a second, and
    // a measurement taken on the way is of neither picture. Asked for less
    // motion it draws the new one at once, inside the event that changed the
    // number. The last test here turns motion back on and waits instead.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
  });

  /** Binoculars of this power on the Moon, with a 7 mm beam so nothing dims. */
  async function binocularsOnTheMoon(page: Page, magnification: number): Promise<void> {
    await instrument(page, 'binoculars');
    await choose(page, 'look-binoculars', 'moon');
    await type(page, { 'bin-power': String(magnification), 'bin-objective': String(magnification * 7) });
    await expect.poll(() => power(page)).toBe(magnification);
  }

  test('control: the eye alone sees the same Moon whatever is held up to it', async ({ page }) => {
    await binocularsOnTheMoon(page, 5);
    const five = await drawn(page, 'bare');
    await binocularsOnTheMoon(page, 8);
    const eight = await drawn(page, 'bare');

    expect(five.disc, 'the eye-alone picture has no Moon in it').toBeGreaterThan(4);
    expect(Math.abs(five.disc - eight.disc),
      `the eye alone was drawn ${five.disc.toFixed(2)} px wide at 5x and ${eight.disc.toFixed(2)} at 8x`)
      .toBeLessThan(0.2);
  });

  test('the close look is wider than the eye alone by the magnification', async ({ page }) => {
    await binocularsOnTheMoon(page, 5);
    const five = { close: await drawn(page, 'close'), bare: await drawn(page, 'bare') };
    await binocularsOnTheMoon(page, 8);
    const eight = { close: await drawn(page, 'close'), bare: await drawn(page, 'bare') };

    // Between the two close looks first: both are tens of pixels wide, so
    // this is the sharp measurement, and it is the claim itself. Eight times
    // is 1.6 times wider than five times.
    expect(off(eight.close.disc / five.close.disc, 8 / 5),
      `the Moon was drawn ${five.close.disc.toFixed(1)} px wide at 5x and `
      + `${eight.close.disc.toFixed(1)} px at 8x`).toBeLessThan(0.02);

    // Then against the eye alone, which is the comparison the page invites.
    // That disc is only a few pixels across, so this one is held more loosely.
    expect(off(five.close.disc / five.bare.disc, 5),
      `5x was drawn ${(five.close.disc / five.bare.disc).toFixed(2)} times the eye alone`)
      .toBeLessThan(0.08);
    expect(off(eight.close.disc / eight.bare.disc, 8),
      `8x was drawn ${(eight.close.disc / eight.bare.disc).toFixed(2)} times the eye alone`)
      .toBeLessThan(0.08);
  });

  test('two instruments at one magnification draw the Moon one size', async ({ page }) => {
    await binocularsOnTheMoon(page, 8);
    const binoculars = await drawn(page, 'close');

    // 400 mm over a 50 mm eyepiece is eight times as well, by a different sum.
    await instrument(page, 'telescope');
    await choose(page, 'look-telescope', 'moon');
    await type(page, { 'tel-aperture': '56', 'tel-focal': '400', 'tel-eyepiece': '50' });
    await expect.poll(() => power(page)).toBe(8);
    const telescope = await drawn(page, 'close');

    expect(off(telescope.disc / binoculars.disc, 1),
      `8x drew the Moon ${binoculars.disc.toFixed(1)} px wide through binoculars and `
      + `${telescope.disc.toFixed(1)} px through a telescope`).toBeLessThan(0.02);
  });

  test('in the whole view the circle is the eyepiece\'s field, and the Moon keeps its size',
    async ({ page }) => {
      // 700 mm over 10 mm is 70 times. The Moon then looks 70 times its half
      // a degree, about 36 degrees wide, whatever eyepiece design shows it.
      await type(page, { 'tel-aperture': '70', 'tel-focal': '700', 'tel-eyepiece': '10' });
      await choose(page, 'look-telescope', 'moon');
      await expect.poll(() => power(page)).toBe(70);

      await assume(page, 'apparent-field', '40');
      await expect.poll(() => shown(page, '#tel-s-field')).toBeCloseTo(40 / 70, 2);
      const narrow = await drawn(page, 'view');

      await assume(page, 'apparent-field', '68');
      await expect.poll(() => shown(page, '#tel-s-field')).toBeCloseTo(68 / 70, 2);
      const wide = await drawn(page, 'view');

      // A wider eyepiece shows a wider circle, in proportion.
      expect(off(wide.circle / narrow.circle, 68 / 40),
        `the circle was ${narrow.circle.toFixed(1)} px at 40 degrees and `
        + `${wide.circle.toFixed(1)} px at 68`).toBeLessThan(0.02);
      // It does not magnify any more, so the Moon in it is the size it was.
      expect(off(wide.disc / narrow.disc, 1),
        `the Moon changed from ${narrow.disc.toFixed(1)} px to ${wide.disc.toFixed(1)} px `
        + 'when only the eyepiece\'s field did').toBeLessThan(0.01);
      // And the Moon's share of each circle is its share of that field, which
      // is the sentence under the picture said in pixels.
      expect(off(narrow.disc / narrow.circle, (70 * MOON_DEGREES) / 40),
        'the Moon is the wrong share of a 40 degree view').toBeLessThan(0.02);
      expect(off(wide.disc / wide.circle, (70 * MOON_DEGREES) / 68),
        'the Moon is the wrong share of a 68 degree view').toBeLessThan(0.02);
    });

  test('with motion left on, the zoom arrives where the number says', async ({ page }) => {
    // The starting picture is taken while the page is still drawing at once,
    // so it is the picture at five times and not one on its way there.
    await binocularsOnTheMoon(page, 5);
    const five = await drawn(page, 'close');

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await type(page, { 'bin-power': '8', 'bin-objective': '56' });
    await expect.poll(async () => off((await drawn(page, 'close')).disc / five.disc, 8 / 5),
      { message: 'the picture never settled at 1.6 times its width at 5x' }).toBeLessThan(0.02);
  });
});

test.describe('magnification-calculator: the dial', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  /** What the telescope's boxes make the magnification, by the sum above. */
  async function quotient(page: Page): Promise<{ eyepiece: number; magnification: number }> {
    const focal = Number(await page.locator('#tel-focal').inputValue());
    const eyepiece = Number(await page.locator('#tel-eyepiece').inputValue());
    return { eyepiece, magnification: focal / eyepiece };
  }

  test('by keyboard it writes the eyepiece, and the readout is still the quotient',
    async ({ page }) => {
      const before = await quotient(page);
      const described = await page.locator('#view').getAttribute('aria-label');

      await page.locator('#dial').focus();
      for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowRight');

      // More magnification from the same telescope is a shorter eyepiece. The
      // dial has no number of its own to disagree with the boxes: it moves one
      // of them, and the readout is worked out from the boxes as before.
      const up = await quotient(page);
      expect(up.eyepiece, 'the dial did not change the eyepiece').toBeLessThan(before.eyepiece);
      await expect.poll(async () => Math.abs((await power(page)) - up.magnification),
        { message: 'the readout and the boxes disagree after the dial moved' })
        .toBeLessThanOrEqual(0.5);
      // The picture is described to somebody who cannot see it, and that
      // description has to move with it.
      await expect(page.locator('#view')).not.toHaveAttribute('aria-label', described ?? '');

      for (let press = 0; press < 6; press += 1) await page.keyboard.press('ArrowLeft');
      const down = await quotient(page);
      expect(down.eyepiece, 'the dial does not come back down').toBeGreaterThan(before.eyepiece);
      await expect.poll(async () => Math.abs((await power(page)) - down.magnification))
        .toBeLessThanOrEqual(0.5);
    });

  test('by pointer it does the same', async ({ page }) => {
    const before = await quotient(page);
    const dial = page.locator('#dial');
    const track = await dial.boundingBox();
    if (!track) throw new Error('the dial is not on the page');

    await dial.click({ position: { x: track.width * 0.9, y: track.height / 2 } });
    const up = await quotient(page);
    expect(up.eyepiece, 'pressing near the top of the track did not shorten the eyepiece')
      .toBeLessThan(before.eyepiece);
    await expect.poll(async () => Math.abs((await power(page)) - up.magnification))
      .toBeLessThanOrEqual(0.5);

    await dial.click({ position: { x: track.width * 0.1, y: track.height / 2 } });
    const down = await quotient(page);
    expect(down.eyepiece, 'pressing near the bottom of the track did not lengthen the eyepiece')
      .toBeGreaterThan(before.eyepiece);
    await expect.poll(async () => Math.abs((await power(page)) - down.magnification))
      .toBeLessThanOrEqual(0.5);
  });

  test('on binoculars it writes the first number and keeps the circle the eyepieces show',
    async ({ page }) => {
      // A field of view is printed for the power it is printed beside: 6.5
      // degrees at 8x is a circle 52 degrees wide to the eye. The same
      // eyepieces at another power still show that circle, so the dial has to
      // move the printed field along with the power or the page would be
      // describing binoculars nobody makes.
      await instrument(page, 'binoculars');
      await type(page, { 'bin-power': '8', 'bin-objective': '42', 'bin-field': '6.5' });

      await page.locator('#dial').focus();
      for (let press = 0; press < 5; press += 1) await page.keyboard.press('ArrowRight');

      const magnification = Number(await page.locator('#bin-power').inputValue());
      const field = Number(await page.locator('#bin-field').inputValue());
      expect(magnification, 'the dial did not change the first number').toBeGreaterThan(8);
      await expect.poll(() => power(page)).toBeCloseTo(magnification, 1);
      expect(off(magnification * field, 8 * 6.5),
        `${magnification}x was left with a ${field} degree field`).toBeLessThan(0.01);
    });
});

test.describe('magnification-calculator: a number it cannot use', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('is named, set aside, and does not stop the rest of the page', async ({ page }) => {
    const error = page.locator('#input-error');
    const aperture = page.locator('#tel-aperture');
    await expect(error, 'the page opens with a complaint').toBeHidden();
    const started = await power(page);

    await type(page, { 'tel-aperture': '2500' });
    await expect(error).toBeVisible();
    await expect(aperture).toHaveAttribute('aria-invalid', 'true');
    // The message is about that box: it begins with the box's own label,
    // whatever language the label is in.
    const label = ((await page.locator('label[for="tel-aperture"]').textContent()) ?? '').trim();
    await expect(error).toContainText(label);

    // The answer stands on what the box last held. A first version of the page
    // stopped here altogether: one number out of range froze the dial and the
    // subjects too, with the reason written beside a box that may have
    // scrolled away.
    expect(await power(page), 'a number the page refused still moved the answer').toBe(started);

    const story = (await page.locator('#answer-story').textContent()) ?? '';
    await choose(page, 'look-telescope', 'jupiter');
    await expect(page.locator('#answer-story'), 'the subject buttons are dead while a box is wrong')
      .not.toHaveText(story);

    const eyepiece = await page.locator('#tel-eyepiece').inputValue();
    await page.locator('#dial').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tel-eyepiece'), 'the dial is dead while a box is wrong')
      .not.toHaveValue(eyepiece);

    // None of which made the fault go away.
    await expect(error).toBeVisible();
    await expect(aperture).toHaveAttribute('aria-invalid', 'true');

    await type(page, { 'tel-aperture': '200' });
    await expect(error).toBeHidden();
    await expect(aperture).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('a box that must hold a number is asked for, and one that may be empty is not',
    async ({ page }) => {
      const error = page.locator('#input-error');

      await type(page, { 'tel-focal': '' });
      await expect(error).toBeVisible();
      await expect(page.locator('#tel-focal')).toHaveAttribute('aria-invalid', 'true');
      await type(page, { 'tel-focal': '900' });
      await expect(error).toBeHidden();

      // A field of view is not printed on every pair. Left empty the box takes
      // a typical one and shows it, so the number in use is never a secret.
      await instrument(page, 'binoculars');
      await type(page, { 'bin-field': '' });
      await expect(error).toBeHidden();
      await expect(page.locator('#bin-field')).toHaveAttribute('placeholder', /\d/);
      await expect(page.locator('#power')).not.toBeEmpty();
    });
});

test.describe('magnification-calculator: a change of language', () => {
  test.skip(!SHIPPED, NOT_YET);

  /** Everything a visitor set, and the digits of the answer it gives. */
  async function everything(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const main = document.getElementById('main')!;
      const state: Record<string, string> = {};
      // The calculator's own card and its assumptions, and nothing the frame
      // may one day put beside them.
      const controls = Array.from(main.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        '.mc-card input, .mc-card select, #assumptions select',
      ));
      for (const control of controls) {
        if (control instanceof HTMLInputElement && control.type === 'radio') {
          if (control.checked) state[control.name] = control.value;
        } else if (control.id !== 'dial') {
          // The dial only follows the boxes. It is not a setting.
          state[control.id] = control.value;
        }
      }
      state.instrument = main.dataset.world ?? '';
      state.answer = (document.getElementById('power')!.textContent ?? '').replace(/\D/g, '');
      return state;
    });
  }

  const ONE_LANGUAGE = 'this page is offered in one language only, so there is no switch to make';

  /** Counted, not opened: the links are in the markup whether or not the menu is. */
  const hasSomewhereToGo = async (page: Page) =>
    (await page.locator('.lang-pick-menu a').count()) > 0;

  /** Follow the switcher to the first language it offers, and wait for that page. */
  async function switchLanguage(page: Page): Promise<void> {
    await page.locator('details.lang-pick summary').first().click();
    // Read before the click. Asked afterwards, the address is already the new
    // one and there is no change left to wait for.
    const from = new URL(page.url()).pathname;
    await Promise.all([
      page.waitForURL((url) => url.pathname !== from, { timeout: 30_000 }),
      page.locator('.lang-pick-menu a').first().click(),
    ]);
    await started(page);
    await expect(page.locator('html'), 'the switch landed on the same language')
      .not.toHaveAttribute('lang', 'en');
  }

  test('everything typed and chosen arrives on the other page', async ({ page }) => {
    // tests/language-switch-state.spec.ts asks this of every tool that takes
    // a file, and says why it leaves the others out: what they would keep is
    // a typed box, which is a different question. This is that question, for
    // a page that is nothing but typed boxes.
    await open(page);
    test.skip(!await hasSomewhereToGo(page), ONE_LANGUAGE);

    // All four instruments moved off what the page starts with. Three of
    // them are not showing when the switch is made, and are carried anyway.
    await instrument(page, 'binoculars');
    await type(page, { 'bin-power': '10', 'bin-objective': '50', 'bin-field': '114' });
    await page.locator('#bin-field-unit').selectOption('metres');
    await choose(page, 'look-binoculars', 'bird-dusk');

    await instrument(page, 'microscope');
    await choose(page, 'mic-objective', '40');
    await type(page, { 'mic-eyepiece': '25' });
    await choose(page, 'look-microscope', 'blood');

    await instrument(page, 'magnifier');
    await type(page, { 'mag-value': '3' });
    await page.locator('#mag-unit').selectOption('dioptre');
    await choose(page, 'look-magnifier', 'ruler');

    await instrument(page, 'telescope');
    await type(page, { 'tel-aperture': '60', 'tel-focal': '900', 'tel-eyepiece': '4' });
    await page.locator('#tel-barlow').selectOption('3');
    await choose(page, 'look-telescope', 'saturn');
    await assume(page, 'eye-pupil', '5');
    await assume(page, 'apparent-field', '68');

    // The dial last, so the eyepiece box holds what the dial wrote and not
    // what was typed, and that is the number that has to arrive.
    await page.locator('#dial').focus();
    for (let press = 0; press < 6; press += 1) await page.keyboard.press('ArrowLeft');

    const before = await everything(page);
    expect(before['tel-eyepiece'], 'the dial did not move the eyepiece').not.toBe('4');
    expect(before.answer, 'there was no answer to carry').not.toBe('');

    await switchLanguage(page);

    // The other page puts the controls back one at a time after it has
    // loaded, so this waits for the last of them.
    await expect.poll(() => everything(page), { timeout: 20_000 }).toEqual(before);
  });

  test('a box the page cannot use travels as typed, and the dial does not travel at all',
    async ({ page }) => {
      await open(page);
      test.skip(!await hasSomewhereToGo(page), ONE_LANGUAGE);

      // An eyepiece the dial could never have written, since it lands on
      // tenths of a millimetre, and then an aperture out of range.
      await type(page, { 'tel-aperture': '60', 'tel-focal': '900', 'tel-eyepiece': '4.37' });
      await page.locator('#tel-barlow').selectOption('3');
      await type(page, { 'tel-aperture': '2500' });
      await expect(page.locator('#input-error')).toBeVisible();

      const before = await everything(page);
      expect(before['tel-eyepiece']).toBe('4.37');

      await switchLanguage(page);

      // The dial is a control like the others, but it only follows the boxes,
      // and the page keeps it out of what travels. The switch skips a control
      // that already holds the value it carried, so a dial that did travel
      // would go unnoticed on a page whose boxes are all in range: the page
      // has put it in the same place itself. Here it has not. The bad aperture
      // is set aside for the one this page starts with, not the one the last
      // page had, the dial sits somewhere else, and a carried dial would be
      // put back and write an eyepiece of its own over the one typed.
      await expect.poll(() => everything(page), { timeout: 20_000 }).toEqual(before);

      // And the fault arrives with its box.
      await expect(page.locator('#input-error')).toBeVisible();
      await expect(page.locator('#tel-aperture')).toHaveAttribute('aria-invalid', 'true');
    });
});

test.describe('magnification-calculator: the promise', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('the numbers typed go nowhere, and a reload forgets them', async ({ page }) => {
    await open(page);
    const address = page.url();

    // Listened for only once the page has loaded. Its own files carry a hash
    // of their contents in the address, and a hash is free to contain any
    // digits it likes.
    const traffic: string[] = [];
    page.on('request', (request) => {
      traffic.push(`${request.method()} ${request.url()} ${(request.postData() ?? '').slice(0, 8000)}`);
    });

    // Numbers nobody arrives at by accident, in boxes that take them, and long
    // enough that a counter in some other request will not hold one by chance.
    const typed = ['19137.25', '137.875'];
    await type(page, { 'tel-focal': typed[0], 'tel-aperture': typed[1] });
    await expect.poll(() => power(page)).toBe(Math.round(19137.25 / 10));
    await choose(page, 'look-telescope', 'saturn');
    await instrument(page, 'microscope');
    await quiet(page);

    for (const entry of traffic) {
      for (const secret of typed) {
        expect(entry, 'a number typed into the calculator was sent somewhere').not.toContain(secret);
      }
    }
    expect(page.url(), 'the address bar is carrying what was typed').toBe(address);

    const kept = await page.evaluate(() =>
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    for (const secret of typed) {
      expect(kept, 'what was typed was written to storage').not.toContain(secret);
    }

    // The page says a reload resets it, which is the same promise from the
    // other side: there is nowhere for the numbers to have been kept.
    await page.reload();
    await started(page);
    await expect(page.locator('#main')).toHaveAttribute('data-world', 'telescope');
    await expect(page.locator('#tel-focal')).not.toHaveValue(typed[0]);
    await expect(page.locator('#tel-aperture')).not.toHaveValue(typed[1]);
  });
});

test.describe('magnification-calculator: what it offers to try', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('every example is a setting the page accepts as written', async ({ page }) => {
    await open(page);

    // Each example carries its settings as the page would be asked for them:
    // the id of a box or the name of a group of radio buttons, and a value.
    // Read from the page, so an example added later is tested the day it is.
    const examples = await page.locator('[data-example]').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-example') ?? ''));
    expect(examples.length, 'the page offers no examples').toBeGreaterThan(0);

    for (const [at, example] of examples.entries()) {
      await page.locator('[data-example]').nth(at).click();
      for (const setting of example.split(' ')) {
        const [key, value] = setting.split('=');
        const box = page.locator(`[id="${key}"]`);
        if (await box.count()) {
          await expect(box, `"${example}" did not set ${key}`).toHaveValue(value);
        } else {
          await expect(page.locator(`input[name="${key}"][value="${value}"]`),
            `"${example}" did not choose ${key}=${value}`).toBeChecked();
        }
      }
      // A limit tightened after an example was written would leave a button
      // that lands on an error. That is the failure this loop is for.
      await expect(page.locator('#input-error'), `"${example}" is refused by the page`).toBeHidden();
      await expect(page.locator('#power'), `"${example}" gives no answer`).not.toBeEmpty();
    }
  });

  test('a row of the same instrument at another power applies itself', async ({ page }) => {
    await open(page);
    const rows = page.locator('#ladder button');
    await expect(rows.first()).toBeVisible();

    // For a telescope each row is an eyepiece, named by its focal length. The
    // first is the longest, which is not the one the page starts on.
    const first = rows.first();
    const eyepiece = await shown(page, '#ladder li:first-child .mc-rung-name');
    await expect(first).not.toHaveAttribute('aria-current', 'true');
    await first.click();

    await expect(page.locator('#tel-eyepiece')).toHaveValue(String(eyepiece));
    const focal = Number(await page.locator('#tel-focal').inputValue());
    await expect.poll(async () => Math.abs((await power(page)) - focal / eyepiece))
      .toBeLessThanOrEqual(0.5);
    // The list is drawn again with that row marked as where the page now is.
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
  });
});
