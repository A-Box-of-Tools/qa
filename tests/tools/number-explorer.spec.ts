import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { quiet } from '../../lib/engine';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the number explorer.
 *
 * The page takes one whole number and says what that many books, drops of
 * water, stars, grains of sand or seconds of counting come to. Three things
 * about that can be wrong without looking wrong.
 *
 * The number itself. It is read from words, suffixes, grouped digits and
 * scientific notation, and it is promised exact up to a 1 followed by thirty
 * zeros, which is far past what a JavaScript number holds. A count read a
 * little wrong is still a count.
 *
 * The five answers. Each is one multiplication by a figure the page states,
 * a 3 cm book or a 0.05 mL drop, and the result is printed in whatever unit
 * suits its size, from milliliters to trillions of light-years. An answer in
 * the wrong unit, or a thousand times out, is still a tidy number with a unit
 * after it.
 *
 * The picture. For water and sand the page claims one thing and says so under
 * the picture: the colored area is the true share of the container's shape.
 * A pyramid a tenth full is not filled a tenth of the way up, and a picture
 * that filled it by height would look just as much like a pyramid with water
 * in it.
 *
 * The website's own unit tests cover the arithmetic these rest on. What is
 * here is what they cannot reach: that the page a browser shows was wired to
 * that arithmetic, and draws what it worked out.
 *
 * WHERE THINGS ARE READ
 *
 * The count comes from the line under the box, which repeats it in digits.
 * The answers come from the five tabs, which show every world's answer at
 * once, and are turned back into meters, cubic meters, seconds or a share of
 * the Milky Way by a small reader of this file's own, so an expectation is
 * never tied to the unit the page happened to choose. The water level comes
 * off the canvas.
 *
 * WHAT IS NOT MEASURED
 *
 * The books, stars and time pictures. Each is drawn with labels, landmarks
 * and a readout over it, and nothing in them can be measured from the pixels
 * without knowing how the page laid them out. They are only checked to be
 * there, and to change when the number does.
 */

const URL_PATH = '/number-explorer/';

const SHIPPED = discoverTools().includes('number-explorer');
const NOT_YET = 'this site does not ship number-explorer yet';

// Nothing here is slow. The allowance is for WebKit on a runner with three
// other workers on it, where a case that takes three seconds at a desk has
// taken thirty.
test.beforeEach(() => {
  test.setTimeout(120_000);
});

type World = 'books' | 'water' | 'stars' | 'sand' | 'time';

/**
 * The figures the page starts with, as it states them in its own assumptions:
 * an everyday 3 cm book, a 0.05 mL drop from a dropper, a spherical 0.5 mm
 * grain packed with 40% air, one item counted each second, a 365.25-day year
 * and a Milky Way of about 100 billion stars.
 */
const BOOK_M = 0.03;
const DROP_M3 = 0.05e-6;
const grainM3 = (millimetres: number) => (Math.PI / 6) * (millimetres / 1000) ** 3 / 0.6;
const YEAR_S = 365.25 * 24 * 60 * 60;
const MILKY_WAY = 1e11;
const LIGHT_YEAR_M = 9.4607e15;

/**
 * What a count of each thing comes to, by this file's own arithmetic: meters
 * of books, cubic meters of water or sand, Milky Ways of stars, and seconds
 * of counting at one a second.
 */
const expected: Record<World, (count: number) => number> = {
  books: (count) => count * BOOK_M,
  water: (count) => count * DROP_M3,
  stars: (count) => count / MILKY_WAY,
  sand: (count) => count * grainM3(0.5),
  time: (count) => count,
};

const WORDS: Record<string, number> = {
  thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12, quadrillion: 1e15,
  quintillion: 1e18, sextillion: 1e21, septillion: 1e24, octillion: 1e27, nonillion: 1e30,
};

/** Units as the page abbreviates them in English, and what one of each is. */
const UNITS: Array<[RegExp, number]> = [
  [/^light-years?$/, LIGHT_YEAR_M], [/^km$/, 1000], [/^m$/, 1], [/^cm$/, 0.01], [/^mm$/, 0.001],
  [/^km³$/, 1e9], [/^m³$/, 1], [/^l$/i, 1e-3], [/^ml$/i, 1e-6],
  [/^(yrs?|years?)$/, YEAR_S], [/^days?$/, 86400], [/^(hrs?|hours?)$/, 3600],
  [/^(mins?|minutes?)$/, 60], [/^(secs?|seconds?|s)$/, 1],
];

/**
 * A tab's answer, as one number: meters of books, cubic meters of water or
 * sand, seconds of counting, or Milky Ways of stars. "30,000 km" is 3e7,
 * "3.17 trillion light-years" is 3e28 and "1% of the Milky Way" is 0.01.
 */
function measure(text: string): number {
  const said = text.replace(/\u00a0/g, ' ').trim();
  const found = /^([\d,]+(?:\.\d+)?)\s*([a-z]+illion|thousand)?\s*(%)?\s*(.*)$/i.exec(said);
  if (!found) throw new Error(`no amount in "${text}"`);
  const amount = Number(found[1].replace(/,/g, '')) * (found[2] ? WORDS[found[2].toLowerCase()] : 1);
  if (!Number.isFinite(amount)) throw new Error(`no amount in "${text}"`);
  if (found[3]) return amount / 100;
  const unit = found[4].trim();
  const known = UNITS.find(([name]) => name.test(unit));
  // Anything else is a count of something named in words, which for a tab is
  // only ever Milky Ways.
  return known ? amount * known[1] : amount;
}

/**
 * Wait for the page to have started. The markup arrives before the modules
 * have run, and the tool takes this warning away only once its listeners are
 * attached, which is also when it writes its first answer. It is a dozen
 * modules, and from a real site on a busy runner they have taken longer to
 * arrive than an assertion waits for by default.
 */
async function started(page: Page): Promise<void> {
  await expect(page.locator('#boot-warning'), 'the page never finished starting')
    .toHaveCount(0, { timeout: 45_000 });
}

/** Open the page and wait for it to have worked something out. */
async function open(page: Page): Promise<void> {
  await page.goto(URL_PATH);
  await started(page);
  await expect(page.locator('#read-number'), 'the page opened without reading its own number')
    .not.toBeEmpty();
}

/** Type a count into the box. */
async function type(page: Page, count: string): Promise<void> {
  await page.locator('#amount').fill(count);
}

/** The count the page says it read: "1,500,000,000 · 1.5 billion" is 1500000000. */
async function countRead(page: Page): Promise<string> {
  const said = (await page.locator('#read-number').textContent()) ?? '';
  return said.split('·')[0].replace(/\D/g, '');
}

/** What one world's tab says the count comes to, in that world's own measure. */
async function answer(page: Page, world: World): Promise<number> {
  return measure((await page.locator(`#tab-${world}`).textContent()) ?? '');
}

/** All five tabs as written, for comparing one state of the page with another. */
async function tabs(page: Page): Promise<string[]> {
  return page.locator('.ne-world-value').allTextContents();
}

async function choose(page: Page, world: World): Promise<void> {
  await page.locator(`[data-world="${world}"]`).click();
  await expect(page.locator('#main')).toHaveAttribute('data-scene', world);
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
  const control = page.locator(`#${id}`);
  if (await control.evaluate((node) => node.tagName === 'SELECT')) await control.selectOption(value);
  else await control.fill(value);
}

/** How far a measured amount is from the one expected, as a fraction of it. */
const off = (measured: number, wanted: number) => Math.abs(measured / wanted - 1);

/** The page prints three significant digits, so half a part in a hundred is its rounding. */
const ROUNDING = 0.006;

test.describe('number-explorer: the count, which is exact', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('every way of writing a count is the same count', async ({ page }) => {
    await type(page, '1,500,000,000');
    await expect.poll(() => countRead(page)).toBe('1500000000');
    const plain = await tabs(page);

    // Words, a suffix, scientific notation, spaces for grouping and no
    // grouping at all. The page's own examples promise the first three.
    const spellings = ['1.5 billion', '1.5b', '1500 million', '15e8', '1.5e9', '1 500 000 000', '1500000000'];
    for (const written of spellings) {
      await type(page, written);
      await expect.poll(() => countRead(page), { message: `"${written}" was read as another number` })
        .toBe('1500000000');
      expect(await tabs(page), `"${written}" gave different answers from the same count`).toEqual(plain);
      await expect(page.locator('#amount')).toHaveAttribute('aria-invalid', 'false');
    }

    // The control: a different count is a different line, so the loop above
    // was not reading a line that never changes.
    await type(page, '1.6 billion');
    await expect.poll(() => countRead(page)).toBe('1600000000');
    expect(await tabs(page)).not.toEqual(plain);
  });

  test('a count past what a double can hold keeps every digit', async ({ page }) => {
    // 2^53 + 1 is the first whole number a JavaScript number cannot hold: read
    // through one, it comes back ending in 2. Thirty digits is the page's limit.
    for (const digits of ['9007199254740993', '123456789012345678901234567890']) {
      await type(page, digits);
      await expect.poll(() => countRead(page), { message: `${digits} lost digits on the way in` })
        .toBe(digits);
    }

    // And through the buttons, which do their own arithmetic on it.
    await type(page, '9007199254740993');
    await page.locator('#more').click();
    await expect.poll(() => countRead(page), { message: 'ten times 2^53 + 1 was rounded' })
      .toBe('90071992547409930');
    await page.locator('#less').click();
    await expect.poll(() => countRead(page), { message: 'a tenth of that did not come back exact' })
      .toBe('9007199254740993');
  });

  test('what is not a whole count is refused, and the last answer stands', async ({ page }) => {
    const box = page.locator('#amount');
    const error = page.locator('#amount-error');

    await type(page, '1 billion');
    await expect(error).toBeHidden();
    const stood = await tabs(page);

    // A fraction, a number past the limit, something that is no number, and
    // nothing at all.
    for (const refused of ['1.5', '1e31', '2 nonillion', 'a few', '']) {
      await type(page, refused);
      await expect(error, `"${refused}" was accepted`).toBeVisible();
      await expect(error).not.toBeEmpty();
      await expect(box).toHaveAttribute('aria-invalid', 'true');
      // Nothing is read back, because nothing was read, and the answers are
      // still the ones for the last number the page could use.
      await expect(page.locator('#read-number')).toBeEmpty();
      expect(await tabs(page), `"${refused}" changed the answers it was refused for`).toEqual(stood);
    }

    // The limit itself is a count, and so is one that only looks fractional.
    for (const [taken, digits] of [['1 nonillion', `1${'0'.repeat(30)}`], ['2.50 thousand', '2500']]) {
      await type(page, taken);
      await expect(error, `"${taken}" was refused`).toBeHidden();
      await expect(box).toHaveAttribute('aria-invalid', 'false');
      await expect.poll(() => countRead(page)).toBe(digits);
    }
  });

  test('ten times more and ten times less are exact, and stop at the ends', async ({ page }) => {
    const less = page.locator('#less');
    const more = page.locator('#more');
    const note = page.locator('#step-note');

    await type(page, '123456');
    await more.click();
    await expect.poll(() => countRead(page)).toBe('1234560');
    await less.click();
    await less.click();
    // 12345.6 is not a count. The page rounds down and says that it did.
    await expect.poll(() => countRead(page)).toBe('12345');
    await expect(note, 'a tenth that was rounded went unremarked').not.toBeEmpty();

    // Five cannot be divided by ten and stay a whole thing, so it stays five.
    await type(page, '5');
    await less.click();
    await expect.poll(() => countRead(page)).toBe('5');
    await expect(note).not.toBeEmpty();

    // The two ends. Nothing is less than none, and one divides to nothing.
    await type(page, '1');
    await expect(less).toBeDisabled();
    await type(page, '0');
    await expect(less).toBeDisabled();
    await expect(more).toBeEnabled();

    await type(page, '1e29');
    await more.click();
    await expect.poll(() => countRead(page)).toBe(`1${'0'.repeat(30)}`);
    await expect(more, 'the page offers ten times its own limit').toBeDisabled();
    await expect(less).toBeEnabled();
  });
});

test.describe('number-explorer: five answers from one number', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('each world\'s answer is its one multiplication, at every size', async ({ page }) => {
    // From a dozen to the page's limit, which takes each answer through every
    // unit it has: milliliters to cubic kilometers, centimeters to trillions
    // of light-years, seconds to sextillions of years.
    const counts: Array<[string, string]> = [
      ['12', '12'], ['4,321', '4321'], ['1 million', '1000000'], ['1 billion', '1000000000'],
      ['3 trillion', '3000000000000'], ['9007199254740993', '9007199254740993'],
      ['7e22', `7${'0'.repeat(22)}`], ['1e30', `1${'0'.repeat(30)}`],
    ];
    for (const [written, digits] of counts) {
      await type(page, written);
      await expect.poll(() => countRead(page)).toBe(digits);
      const count = Number(digits);
      for (const world of ['books', 'water', 'sand', 'time'] as const) {
        const wanted = expected[world](count);
        const said = await answer(page, world);
        expect(off(said, wanted),
          `${written} ${world}: the page says ${await page.locator(`#tab-${world}`).textContent()}, `
          + `which is ${said.toPrecision(4)} where the arithmetic gives ${wanted.toPrecision(4)}`)
          .toBeLessThan(ROUNDING);
      }

      // Stars are a share of the Milky Way until there are more than one of
      // them. Under a hundred-millionth the page says "less than" instead of
      // printing a row of noughts, which is the one answer that is not a
      // number to check.
      const share = count / MILKY_WAY;
      const stars = ((await page.locator('#tab-stars').textContent()) ?? '').trim();
      if (share < 1e-8) {
        expect(stars, `${written} stars: a share too small to print was printed anyway`).toMatch(/^</);
      } else {
        expect(off(measure(stars), share), `${written} stars: the page says ${stars}`)
          .toBeLessThan(ROUNDING);
        expect(stars.includes('%'), `${written} stars: ${stars}`).toBe(share < 1);
      }
    }
  });

  test('the answer written large is the chosen world\'s, and agrees with its tab', async ({ page }) => {
    await type(page, '1 billion');
    const large = page.locator('#answer-number');
    const seen: string[] = [];
    for (const world of ['books', 'water', 'stars', 'sand', 'time'] as const) {
      await choose(page, world);
      await expect(page.locator(`[data-world="${world}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-world][aria-pressed="true"]')).toHaveCount(1);
      // The same figure the tab carries, with its unit spelled out beside it.
      const figure = ((await large.textContent()) ?? '').trim();
      const tab = ((await page.locator(`#tab-${world}`).textContent()) ?? '').trim();
      expect(tab.startsWith(figure), `${world}: the large answer says ${figure} and its tab says ${tab}`)
        .toBe(true);
      seen.push(figure);
    }
    // Five worlds, and no two of them the same size at a billion.
    expect(new Set(seen).size, `the five answers were ${seen.join(', ')}`).toBe(5);
  });

  test('an assumption moves its own answer in proportion, and no other', async ({ page }) => {
    await type(page, '1 billion');
    const before = {
      books: await answer(page, 'books'), water: await answer(page, 'water'),
      sand: await answer(page, 'sand'), time: await answer(page, 'time'),
    };
    const stars = await page.locator('#tab-stars').textContent();

    /** Wait for one world's answer to be this many times what it was. */
    const scaled = (world: keyof typeof before, by: number, message?: string) =>
      expect.poll(async () => off((await answer(page, world)) / before[world], by), { message })
        .toBeLessThan(ROUNDING);

    // A doorstop of a book is 5 cm where an everyday one is 3.
    await assume(page, 'book-thickness', '0.05');
    await scaled('books', 5 / 3);

    // A dripping tap's drop is five droppers' worth.
    await assume(page, 'drop-size', '0.25');
    await scaled('water', 5);

    // Twice the diameter is eight times the sand, and half is an eighth,
    // because a grain is a volume. A page that scaled by the diameter would
    // say twice and half.
    await assume(page, 'grain-size', '1');
    await scaled('sand', 8, 'grains twice as wide did not take eight times the room');
    await assume(page, 'grain-size', '0.25');
    await scaled('sand', 1 / 8);

    // Ten at a time is a tenth of the time, and a hundred a hundredth, which
    // takes the answer from years down to days.
    await assume(page, 'count-rate', '10');
    await scaled('time', 1 / 10);
    await assume(page, 'count-rate', '100');
    await scaled('time', 1 / 100);

    // None of that is about stars, and none of it touched the count.
    expect(await page.locator('#tab-stars').textContent()).toBe(stars);
    expect(await countRead(page)).toBe('1000000000');
  });

  test('a word or an AI token is a share of a book, at a length that can be changed',
    async ({ page }) => {
      const row = page.locator('#unit-row');
      const length = page.locator('#book-length');
      const error = page.locator('#settings-error');
      await type(page, '1 million');

      // A million tokens at 0.75 words each is 750,000 words, which at 75,000
      // words to a book is ten books, and ten 3 cm books are 30 cm.
      await row.locator('[data-unit="token"]').click();
      await expect(row.locator('[data-unit="token"]')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => off(await answer(page, 'books'), 1e6 * 0.75 / 75000 * BOOK_M))
        .toBeLessThan(ROUNDING);

      // A million words is thirteen and a third of them.
      await row.locator('[data-unit="word"]').click();
      await expect.poll(async () => off(await answer(page, 'books'), 1e6 / 75000 * BOOK_M))
        .toBeLessThan(ROUNDING);

      await assume(page, 'book-length', '150000');
      await expect.poll(async () => off(await answer(page, 'books'), 1e6 / 150000 * BOOK_M))
        .toBeLessThan(ROUNDING);

      // Fifty words is not a book. The page says so, and goes on answering
      // with the last length it accepted: an unfinished edit must not quietly
      // become the answer.
      await assume(page, 'book-length', '50');
      await expect(error).toBeVisible();
      await expect(length).toHaveAttribute('aria-invalid', 'true');
      expect(off(await answer(page, 'books'), 1e6 / 150000 * BOOK_M),
        'a book length the page refused still changed the answer').toBeLessThan(ROUNDING);

      await assume(page, 'book-length', '100000');
      await expect(error).toBeHidden();
      await expect(length).toHaveAttribute('aria-invalid', 'false');
      await expect.poll(async () => off(await answer(page, 'books'), 1e6 / 100000 * BOOK_M))
        .toBeLessThan(ROUNDING);

      // What one counted thing is belongs to the books. Nothing else asks.
      await choose(page, 'water');
      await expect(row).toBeHidden();
      await choose(page, 'books');
      await expect(row).toBeVisible();
    });
});

test.describe('number-explorer: moving the number', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  /** The count now in the box, the dial's own position, and what the dial says of itself. */
  async function dialled(page: Page): Promise<{ count: string; position: number; said: string }> {
    const dial = page.locator('#dial');
    return {
      count: await countRead(page),
      position: Number(await dial.inputValue()),
      said: (await dial.getAttribute('aria-valuetext')) ?? '',
    };
  }

  test('the dial lands on a count that can be read, and the box follows it', async ({ page }) => {
    await type(page, '1 billion');
    await page.locator('#dial').focus();

    // A quarter of a power of ten at a time. Ten to the 9.25 is 1,778,279,410,
    // which nobody can read off a dial, so it lands on two digits: 1.8 billion.
    await page.keyboard.press('ArrowRight');
    let now = await dialled(page);
    expect(now.position).toBeCloseTo(9.25, 5);
    expect(now.count.replace(/0+$/, '').length,
      `the dial landed on ${now.count}, which is more than two digits to read`).toBeLessThanOrEqual(2);
    expect(off(Number(now.count), 10 ** now.position), `the dial at ${now.position} gave ${now.count}`)
      .toBeLessThan(0.06);
    // What the dial calls itself to somebody who cannot see it is the count.
    expect(now.said).toBe((await page.locator('#read-number').textContent()) ?? '');

    // A whole power of ten at a time.
    await page.keyboard.press('PageUp');
    now = await dialled(page);
    expect(now.position).toBeCloseTo(10.25, 5);
    expect(off(Number(now.count), 10 ** now.position)).toBeLessThan(0.06);

    // And on a whole power it is that power exactly, not 9.9 or 10 billion
    // rounded to it.
    await page.keyboard.press('ArrowLeft');
    now = await dialled(page);
    expect(now.count, `the dial at ${now.position} is not exactly ten billion`).toBe(`1${'0'.repeat(10)}`);

    // The far end of the track is the page's limit.
    const dial = page.locator('#dial');
    const track = await dial.boundingBox();
    if (!track) throw new Error('the dial is not on the page');
    await dial.click({ position: { x: track.width - 1, y: track.height / 2 } });
    await expect.poll(() => countRead(page), { message: 'the top of the dial is not the largest count' })
      .toBe(`1${'0'.repeat(30)}`);
    await expect(page.locator('#more')).toBeDisabled();
  });

  test('a landmark jumps to the smallest round count that reaches it', async ({ page }) => {
    await type(page, '1 billion');
    // The Moon is 384,400 km up, which is how the page lists it. It is found
    // by that figure rather than by its name.
    const moon = page.locator('#ladder button', {
      has: page.locator('.ne-rung-size', { hasText: '384,400' }),
    });
    await expect(moon, 'the ladder beside a billion books has no Moon on it').toHaveCount(1);
    await expect(moon.locator('.ne-rung-ratio'), 'a billion books already reach the Moon')
      .toContainText('%');
    await moon.click();

    // 384,400 km of 3 cm books is 12,813,333,334 of them. The page rounds a
    // worked-back count to three digits, and it has to round up: the nearest
    // would be 12.8 billion, which stops 400 km short of what was asked for.
    const exactly = BigInt(Math.ceil(384_400_000 / BOOK_M));
    const step = 10n ** BigInt(exactly.toString().length - 3);
    const rounded = exactly % step === 0n ? exactly : (exactly / step + 1n) * step;
    await expect.poll(() => countRead(page)).toBe(rounded.toString());
    expect(await answer(page, 'books'), 'the count jumped to does not reach the Moon')
      .toBeGreaterThanOrEqual(384_400_000 * (1 - ROUNDING));
    expect(Number(rounded - step) * BOOK_M, 'a rounder count one step lower would have reached it too')
      .toBeLessThan(384_400_000);

    // The row is drawn again as passed, and the page says what it just did.
    const reached = page.locator('#ladder button', {
      has: page.locator('.ne-rung-size', { hasText: '384,400' }),
    });
    await expect(reached.locator('.ne-rung-ratio')).not.toContainText('%');
    await expect(page.locator('#step-note')).not.toBeEmpty();
  });

  test('a landmark no count here can reach is not offered, until the assumptions let it be',
    async ({ page }) => {
      await choose(page, 'water');
      await type(page, '1 billion');
      await page.locator('#ladder-all').click();
      await expect(page.locator('#ladder-all')).toHaveAttribute('aria-expanded', 'true');

      // Neptune holds 62.54 trillion cubic kilometers, by the page's figure.
      // At 0.05 mL a drop that is 1.25 nonillion drops, and the page stops at
      // one nonillion.
      const neptune = page.locator('#ladder button', {
        has: page.locator('.ne-rung-size', { hasText: '62.54 trillion' }),
      });
      await expect(neptune, 'the full ladder has no Neptune on it').toHaveCount(1);
      expect(6.254e22 / DROP_M3).toBeGreaterThan(1e30);
      await expect(neptune, 'a jump past the largest count is on offer').toBeDisabled();

      // A dripping tap's drop is five times the size, and a quarter of a
      // nonillion of those is enough.
      await assume(page, 'drop-size', '0.25');
      expect(6.254e22 / (5 * DROP_M3)).toBeLessThan(1e30);
      await expect(neptune).toBeEnabled();
    });

  test('the guess is about ten times more, and the page knows the answer', async ({ page }) => {
    const box = page.locator('#guess-box');

    // A million books stand 30 km high. Ten times that is 300 km, and the next
    // thing up is the Space Station at 400.
    await type(page, '1 million');
    await expect(box).toBeVisible();
    await expect(box, 'ten million books were said to reach the Space Station')
      .toHaveAttribute('data-reaches', 'false');

    // A billion stand 30,000 km, and ten times that is well past a trip
    // around the Earth.
    await type(page, '1 billion');
    await expect(box).toHaveAttribute('data-reaches', 'true');

    // Either answer takes the step it asked about, and says who was right.
    await page.locator('#guess-yes').click();
    await expect.poll(() => countRead(page)).toBe('10000000000');
    await expect(page.locator('#guess-answer')).toBeVisible();
    await expect(page.locator('#guess-answer')).not.toBeEmpty();

    // There is no ten times more than the limit to ask about.
    await type(page, '1e30');
    await expect(box).toBeHidden();
  });

  test('every example sets the world, the number and the thing it names', async ({ page }) => {
    // Each carries its settings as "world:number:unit". Read off the page, so
    // an example added later is tested the day it is.
    const examples = await page.locator('[data-example]').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-example') ?? ''));
    expect(examples.length, 'the page offers no examples').toBeGreaterThan(0);

    for (const [at, example] of examples.entries()) {
      const [world, number, unit] = example.split(':');
      await page.locator('[data-example]').nth(at).click();
      await expect(page.locator('#main'), `"${example}" did not open ${world}`)
        .toHaveAttribute('data-scene', world);
      await expect(page.locator('#amount')).toHaveValue(number);
      await expect(page.locator('#amount-error'), `"${example}" is a number the page refuses`).toBeHidden();
      await expect(page.locator('#read-number')).not.toBeEmpty();
      await expect(page.locator(`[data-unit="${unit || 'book'}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('a question that changes what each one is leaves how many alone', async ({ page }) => {
    await type(page, '7,654,321');
    const offered = page.locator('#followups button');
    await expect(offered.first()).toBeVisible();
    await offered.first().click();
    // From books to something else, with the same count behind it.
    await expect(page.locator('#main')).not.toHaveAttribute('data-scene', 'books');
    expect(await countRead(page)).toBe('7654321');
  });
});

test.describe('number-explorer: the picture', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    // The stage stops drawing while less than a quarter of it is on screen,
    // and the box is a screen above it. A window tall enough to hold both
    // keeps typing from scrolling the picture out of sight halfway through.
    const size = page.viewportSize();
    if (size) await page.setViewportSize({ width: size.width, height: 1800 });
  });

  /** Let the stage draw: it paints on the next frame after something changes. */
  async function painted(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    }));
  }

  /**
   * Type a count and wait for the picture to be a different one. The box
   * answers at once and the stage a frame later, so a measurement taken in
   * between would be of the number before.
   */
  async function draw(page: Page, count: string): Promise<void> {
    const was = await sum(page);
    await type(page, count);
    await expect.poll(() => sum(page), { message: `the picture did not change for ${count}` })
      .not.toBe(was);
    await painted(page);
  }

  /**
   * Where the water is on the picture's middle column, in the canvas's own
   * pixels: its surface and its floor. Down that column water is the only
   * thing drawn that is far bluer than it is red. The sky is paler, and so is
   * the sea a supertanker floats on.
   */
  async function water(page: Page): Promise<{ surface: number; floor: number } | null> {
    return page.evaluate(() => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement;
      const { width, height } = canvas;
      if (!width || !height) return null;
      const column = canvas.getContext('2d')!.getImageData(Math.floor(width / 2), 0, 1, height).data;
      let surface = -1;
      let floor = -1;
      for (let y = 0; y < height; y += 1) {
        if (column[y * 4 + 2] - column[y * 4] > 130) {
          if (surface < 0) surface = y;
          floor = y;
        }
      }
      return surface < 0 ? null : { surface, floor };
    });
  }

  /** Every pixel of the picture added up: a number that moves if anything in it does. */
  async function sum(page: Page): Promise<number> {
    return page.evaluate(() => {
      const canvas = document.getElementById('stage') as HTMLCanvasElement;
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let total = 0;
      for (let at = 0; at < data.length; at += 4) total += data[at] + 2 * data[at + 1] + 3 * data[at + 2];
      return total;
    });
  }

  test('water rises by the share of the shape it fills, not by its height', async ({ page }) => {
    // Motion is reduced so the level is where the number puts it as soon as it
    // is drawn, with no pour on the way and no ripple on the surface.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await choose(page, 'water');

    /** The surface at each of three shares of one container, top of the canvas downward. */
    async function levels(drops: number): Promise<number[]> {
      const found: number[] = [];
      for (const share of [0.2, 0.4, 0.8]) {
        await draw(page, String(Math.round(drops * share)));
        const seen = await water(page);
        if (!seen) throw new Error(`no water was drawn at ${share * 100}% of the container`);
        // More water is a higher surface, whatever shape it is in.
        expect(seen.surface, `the surface at ${share * 100}% is no higher than the one before it`)
          .toBeLessThan(found.at(-1) ?? Infinity);
        found.push(seen.surface);
      }
      return found;
    }
    /** How much further the surface climbs from 40% to 80% than from 20% to 40%. */
    const climb = ([fifth, twoFifths, fourFifths]: number[]) =>
      (twoFifths - fourFifths) / (fifth - twoFifths);

    // The control: a room is a box, 5 by 3 by 2 meters on the page, so twice
    // the water is twice as deep. 30 cubic meters is 600 million drops.
    const room = climb(await levels(30 / DROP_M3));
    expect(off(room, (0.8 - 0.4) / (0.4 - 0.2)),
      `in a room the surface climbed ${room.toFixed(2)} times as far for twice the share`)
      .toBeLessThan(0.08);

    // The Great Pyramid, about 2.6 million cubic meters. It narrows, so the
    // same shares stand higher the fuller it gets: a share s of a triangle's
    // area reaches 1 - sqrt(1 - s) of the way up it. Filled by height instead
    // it would climb like the room, by 2.
    const up = (share: number) => 1 - Math.sqrt(1 - share);
    const pyramid = climb(await levels(2.6e6 / DROP_M3));
    expect(off(pyramid, (up(0.8) - up(0.4)) / (up(0.4) - up(0.2))),
      `in a pyramid the surface climbed ${pyramid.toFixed(2)} times as far for twice the share, `
      + `where its shape needs ${((up(0.8) - up(0.4)) / (up(0.4) - up(0.2))).toFixed(2)} and a box 2`)
      .toBeLessThan(0.08);
  });

  test('every world draws, and draws something else for another number', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    // With motion reduced there is nothing to play or pause, so the page
    // takes the buttons away rather than leave two that do nothing.
    await expect(page.locator('#stage-controls')).toBeHidden();

    const seen = new Set<number>();
    for (const world of ['books', 'water', 'stars', 'sand', 'time'] as const) {
      await choose(page, world);
      await draw(page, '1 thousand');
      const small = await sum(page);
      await draw(page, '1 trillion');
      const large = await sum(page);
      // Still, because nothing here should be moving.
      await painted(page);
      expect(await sum(page), `the ${world} picture is moving with motion reduced`).toBe(large);
      seen.add(small);
      seen.add(large);
    }
    // Five worlds at two numbers each, and no two of the ten alike.
    expect(seen.size, 'two worlds or two numbers were drawn as the same picture').toBe(10);
  });

  /** Whether the picture changes over a third of a second. */
  async function moving(page: Page): Promise<boolean> {
    const first = await sum(page);
    await page.waitForTimeout(350);
    return (await sum(page)) !== first;
  }

  test('growing from one can be stopped, and stops by itself at the number', async ({ page }) => {
    await open(page);
    const play = page.locator('#play');
    await expect(page.locator('#stage-controls')).toBeVisible();
    // The page opens by doing exactly this, unasked: the picture grows from
    // one to the number, and the button is a Stop for as long as it takes.
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await expect(play, 'the opening journey never finished')
      .toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    const resting = (await page.locator('#play-label').textContent()) ?? '';

    // Asked for, it is the same journey, and it says something else while it runs.
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#play-label')).not.toHaveText(resting);
    await expect.poll(() => moving(page), { message: 'the picture is not growing' }).toBe(true);

    // Pressed again it stops where the number is, and the number has not moved.
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#play-label')).toHaveText(resting);
    expect(await countRead(page)).toBe('1000000000');

    // Left alone it ends by itself. A thousand is a short way to grow.
    await type(page, '1 thousand');
    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await expect(play, 'the journey to a thousand never ended')
      .toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    expect(await countRead(page)).toBe('1000');
  });

  test('pausing motion stops the picture, and resuming starts it again', async ({ page }) => {
    await open(page);
    const play = page.locator('#play');
    const still = page.locator('#still');
    await expect(page.locator('#stage-controls')).toBeVisible();
    // The page opens by growing the picture from one, which is over when the
    // button can be pressed again.
    await expect(play).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });
    await choose(page, 'water');
    // Water does not sit still: the surface swells and there is a drip.
    await expect.poll(() => moving(page), { message: 'the water picture is not moving to begin with' })
      .toBe(true);

    await still.click();
    await expect(still).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => moving(page), { message: 'the picture went on moving after motion was paused' })
      .toBe(false);
    // Paused is not frozen: a new number is still drawn, at once.
    const paused = await sum(page);
    await type(page, '2 billion');
    await expect.poll(() => sum(page), { message: 'a paused picture ignored a new number' })
      .not.toBe(paused);
    await expect.poll(() => moving(page)).toBe(false);

    await still.click();
    await expect(still).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => moving(page), { message: 'the picture stayed still after motion was resumed' })
      .toBe(true);
  });
});

test.describe('number-explorer: the picture it saves', () => {
  test.skip(!SHIPPED, NOT_YET);

  /** Save the picture and hand back the file and the name the page gave it. */
  async function save(page: Page): Promise<{ bytes: Buffer; name: string }> {
    const pending = page.waitForEvent('download');
    await page.locator('#download-picture').click();
    const saved = await pending;
    const where = await saved.path();
    if (!where) throw new Error('the browser saved no file');
    return { bytes: fs.readFileSync(where), name: saved.suggestedFilename() };
  }

  /**
   * Open a saved picture in the browser, as anything that receives it would,
   * and say what is in it: its size, how many colors the scene at the top
   * holds, how deep the water stands on the scene's middle column, and how
   * much of the strip under the scene is white and how much ink.
   */
  async function look(page: Page, bytes: Buffer, sceneHeight: number) {
    return page.evaluate(async ([encoded, scene]) => {
      const raw = Uint8Array.from(atob(encoded as string), (char) => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([raw], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const top = scene as number;
      const colors = new Set<string>();
      const picture = context.getImageData(0, 0, image.width, top).data;
      for (let at = 0; at < picture.length; at += 4 * 997) {
        colors.add(`${picture[at] >> 3},${picture[at + 1] >> 3},${picture[at + 2] >> 3}`);
      }
      // A file no taller than its scene has no strip to read, and says so by
      // having none of either.
      const strip = image.height > top
        ? context.getImageData(0, top, image.width, image.height - top).data
        : new Uint8ClampedArray(0);
      const pixels = Math.max(1, strip.length / 4);
      let white = 0;
      let ink = 0;
      for (let at = 0; at < strip.length; at += 4) {
        const light = strip[at] + strip[at + 1] + strip[at + 2];
        if (light > 720) white += 1;
        else if (light < 300) ink += 1;
      }
      // Water is far bluer than it is red, as it is on the page's own stage.
      const column = context.getImageData(Math.floor(image.width / 2), 0, 1, top).data;
      let surface = -1;
      let floor = -1;
      for (let y = 0; y < top; y += 1) {
        if (column[y * 4 + 2] - column[y * 4] > 130) {
          if (surface < 0) surface = y;
          floor = y;
        }
      }
      return {
        width: image.width, height: image.height, colors: colors.size, depth: floor - surface,
        white: white / pixels, ink: ink / pixels,
      };
    }, [bytes.toString('base64'), sceneHeight] as const);
  }

  test('is a PNG of this number\'s scene with what it means written under it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await choose(page, 'water');
    // A room is 30 cubic meters on the page, which is 600 million drops, so
    // this is a room half full.
    await type(page, '300 million');

    const half = await save(page);
    expect(half.name, 'the file is not named for the world it shows').toBe('number-explorer-water.png');
    expect(half.bytes.subarray(0, 8).toString('hex'), 'the file is not a PNG').toBe('89504e470d0a1a0a');
    await expect(page.locator('#save-note')).not.toBeEmpty();

    // The scene is 1000 by 562 at two pixels to one, and the page promises the
    // number, its answer and the assumptions travel under it. So the file is
    // taller than the scene, and what is under the scene is ink on white.
    const first = await look(page, half.bytes, 1124);
    expect(first.width).toBe(2000);
    expect(first.height, 'nothing is written under the scene').toBeGreaterThan(1124 + 100);
    expect(first.colors, 'the scene is one flat color').toBeGreaterThan(12);
    expect(first.white, 'the strip under the scene is not a white one').toBeGreaterThan(0.8);
    expect(first.ink, 'nothing is written on the strip under the scene').toBeGreaterThan(0.005);

    // And it is this number's picture, to scale, not one the page keeps for
    // every number. The file is painted afresh at its own size, so it cannot
    // be laid over the stage, but a room is a box: five sixths full it holds
    // water five thirds as deep as it did half full.
    expect(first.depth, 'the saved room has no water in it').toBeGreaterThan(50);
    await type(page, '500 million');
    const fuller = await look(page, (await save(page)).bytes, 1124);
    expect(off(fuller.depth / first.depth, (5 / 6) / (1 / 2)),
      `the saved water stood ${first.depth} px deep for 300 million drops `
      + `and ${fuller.depth} px for 500 million`).toBeLessThan(0.05);

    await choose(page, 'stars');
    expect((await save(page)).name).toBe('number-explorer-stars.png');
  });
});

test.describe('number-explorer: a change of language', () => {
  test.skip(!SHIPPED, NOT_YET);

  const ONE_LANGUAGE = 'this page is offered in one language only, so there is no switch to make';

  /** Counted, not opened: the links are in the markup whether or not the menu is. */
  const hasSomewhereToGo = async (page: Page) =>
    (await page.locator('.lang-pick-menu a').count()) > 0;

  /**
   * Follow the switcher to German where it is offered, since that is where the
   * same words name another number, and to whatever comes first where it is not.
   */
  async function switchLanguage(page: Page): Promise<void> {
    await page.locator('details.lang-pick summary').first().click();
    const menu = page.locator('details.lang-pick').first().locator('.lang-pick-menu');
    const german = menu.locator('a[hreflang="de"]');
    const link = (await german.count()) ? german : menu.locator('a').first();
    // Read before the click. Asked afterwards, the address is already the new
    // one and there is no change left to wait for.
    const from = new URL(page.url()).pathname;
    await Promise.all([
      page.waitForURL((url) => url.pathname !== from, { timeout: 30_000 }),
      link.click(),
    ]);
    await started(page);
    await expect(page.locator('html'), 'the switch landed on the same language')
      .not.toHaveAttribute('lang', 'en');
  }

  test('a count in words arrives as the same number, whatever those words mean there',
    async ({ page }) => {
      await open(page);
      test.skip(!await hasSomewhereToGo(page), ONE_LANGUAGE);

      // "2 billion" is two thousand million in English. In German, French and
      // Spanish the same word is a million million, so carried as typed it
      // would arrive a thousand times too big and look perfectly reasonable.
      await type(page, '2 billion');
      await expect.poll(() => countRead(page)).toBe('2000000000');
      await assume(page, 'book-thickness', '0.05');
      await assume(page, 'drop-size', '0.25');
      await assume(page, 'grain-size', '1');
      await assume(page, 'count-rate', '10');
      await assume(page, 'book-length', '120000');

      await switchLanguage(page);

      // The other page puts the controls back one at a time after it loads,
      // so the count is waited for and the rest are there by then.
      await expect.poll(() => countRead(page), { timeout: 20_000,
        message: 'two billion did not arrive as two thousand million' }).toBe('2000000000');
      // In digits, the one spelling every language reads alike.
      await expect(page.locator('#amount')).toHaveValue('2000000000');
      await expect(page.locator('#amount')).toHaveAttribute('aria-invalid', 'false');
      await expect(page.locator('#book-thickness')).toHaveValue('0.05');
      await expect(page.locator('#drop-size')).toHaveValue('0.25');
      await expect(page.locator('#grain-size')).toHaveValue('1');
      await expect(page.locator('#count-rate')).toHaveValue('10');
      await expect(page.locator('#book-length')).toHaveValue('120000');
    });

  test('a count the page could not read arrives as typed, and the dial stays behind',
    async ({ page }) => {
      await open(page);
      test.skip(!await hasSomewhereToGo(page), ONE_LANGUAGE);
      const box = page.locator('#amount');
      const dial = page.locator('#dial');

      // A count the dial follows up to three trillion, and then one and a half
      // of something, which is not a count. The dial stays where the last
      // real number left it.
      await type(page, '3 trillion');
      await expect.poll(() => countRead(page)).toBe('3000000000000');
      const left = await dial.inputValue();
      await type(page, '1.5');
      await expect(page.locator('#amount-error')).toBeVisible();
      expect(await dial.inputValue()).toBe(left);

      await switchLanguage(page);

      // What was typed is what arrives, with the page still saying it cannot
      // use it. The switch does not tidy a number it could not read.
      await expect(box).toHaveValue('1.5', { timeout: 20_000 });
      await expect(page.locator('#amount-error')).toBeVisible();
      await expect(box).toHaveAttribute('aria-invalid', 'true');

      // The dial only follows the box, in two digits, and the page keeps it
      // out of what travels. The switch skips a control that already holds
      // the value it carried, so a dial that did travel goes unnoticed beside
      // a count the page can read: the page has put it in the same place
      // itself. Beside one it cannot read, the dial is where this page
      // started it, a carried one would be put back after the box, and the
      // page would take that for somebody dragging it and write three
      // trillion into the box.
      expect(await dial.inputValue(), 'the dial travelled with the language switch')
        .toBe((await dial.getAttribute('value')) ?? '');
      await expect(box, 'the dial wrote over what was typed').toHaveValue('1.5');
    });
});

test.describe('number-explorer: the promise', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('the number typed goes nowhere, and a reload forgets it', async ({ page }) => {
    await open(page);
    const address = page.url();
    const box = page.locator('#amount');
    const starting = (await box.getAttribute('value')) ?? '';

    // Listened for only once the page has loaded. Its own files carry a hash
    // of their contents in the address, and a hash is free to contain any
    // digits it likes.
    const traffic: string[] = [];
    page.on('request', (request) => {
      traffic.push(`${request.method()} ${request.url()} ${(request.postData() ?? '').slice(0, 8000)}`);
    });

    // A number nobody arrives at by accident, taken through everything the
    // page does with one: every world, a different assumption, a saved picture.
    const secret = '73194620851';
    await type(page, secret);
    await expect.poll(() => countRead(page)).toBe(secret);
    for (const world of ['water', 'stars', 'sand', 'time', 'books'] as const) await choose(page, world);
    await assume(page, 'book-length', '913572');
    const pending = page.waitForEvent('download');
    await page.locator('#download-picture').click();
    await pending;
    await quiet(page);

    for (const entry of traffic) {
      // A saved picture is a blob the page hands to the browser, which is not
      // a request to anywhere, and is the one address allowed to exist here.
      if (/^GET blob:/.test(entry)) continue;
      expect(entry, 'the number typed into the explorer was sent somewhere').not.toContain(secret);
      expect(entry, 'a setting typed into the explorer was sent somewhere').not.toContain('913572');
    }
    expect(page.url(), 'the address bar is carrying the number').toBe(address);

    const kept = await page.evaluate(() =>
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    expect(kept, 'the number was written to storage').not.toContain(secret);

    // The page says a reload resets the exploration, which is the same
    // promise from the other side: there is nowhere for it to have been kept.
    await page.reload();
    await started(page);
    await expect(box).toHaveValue(starting);
    await expect(page.locator('#main')).toHaveAttribute('data-scene', 'books');
    await expect(page.locator('#book-length')).not.toHaveValue('913572');
  });
});
