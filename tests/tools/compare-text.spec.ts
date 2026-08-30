import { test, expect, type Page } from '@playwright/test';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the comparer.
 *
 * A diff has one failure mode that matters and it is silent: saying two
 * things are the same when they are not. Somebody comparing a config against
 * a working one, or a contract against the version they signed, acts on
 * "identical" without reading further - so every test here that asserts
 * sameness is paired with a control proving the tool could have seen the
 * difference if there had been one.
 *
 * That pairing is the whole design of this file. The ignore switches make it
 * necessary: "these are the same when you ignore case" is only meaningful if
 * the same two inputs are reported as different with the switch off.
 */

const URL_PATH = '/compare-text/';

/**
 * Put both sides in and wait for a verdict.
 *
 * Clearing first is not tidiness, it is the whole reliability of this file.
 * The note is never empty - with the boxes empty it asks you to paste
 * something - so "wait until it is not empty" returns instantly with whatever
 * the last comparison concluded. The first draft of this file read the
 * previous verdict every time and reported the tool as both blind to
 * differences and inventing them, neither of which was true.
 *
 * Cleared, the note returns to its resting text; a verdict is then anything
 * that is not that.
 */
async function compare(page: Page, left: string, right: string): Promise<string> {
  const note = page.locator('#result-note');
  await page.locator('#clear').click();
  const resting = (await note.textContent()) ?? '';

  await page.locator('#input').fill(left);
  await page.locator('#input-b').fill(right);
  await expect(note).not.toHaveText(resting, { timeout: 20_000 });
  return (await note.textContent()) ?? '';
}

/**
 * Flip a switch and wait for the verdict to be recomputed, rather than
 * reading the one already on screen.
 */
async function afterSwitch(page: Page, id: string): Promise<string> {
  const note = page.locator('#result-note');
  const before = (await note.textContent()) ?? '';
  await page.locator(id).check();
  await expect(note).not.toHaveText(before, { timeout: 20_000 });
  return (await note.textContent()) ?? '';
}

/** The tool's two ways of saying "no differences". */
const SAYS_SAME = /identical|the same|no difference/i;

test.describe('compare-text: finding the difference', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('a difference is found, and identical text is reported as identical', async ({ page }) => {
    const changed = await compare(page, 'one\ntwo\nthree', 'one\ntwo\nTHREE');
    expect(changed).not.toMatch(SAYS_SAME);

    const same = await compare(page, 'one\ntwo\nthree', 'one\ntwo\nthree');
    expect(same).toMatch(SAYS_SAME);
  });

  test('a difference in the middle of a long file is not missed', async ({ page }) => {
    // The interesting case for a diff is not two short strings; it is one
    // changed line surrounded by hundreds of identical ones, which is where a
    // windowed or truncated comparison quietly stops looking.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    const other = [...lines];
    other[287] = 'line 287 CHANGED';

    const note = await compare(page, lines.join('\n'), other.join('\n'));
    expect(note, 'a single changed line among four hundred was not found')
      .not.toMatch(SAYS_SAME);
    await expect(page.locator('#diff-view')).toContainText('CHANGED');
  });

  test('a difference in trailing whitespace is still a difference', async ({ page }) => {
    // Invisible on screen, and the reason two files that look identical are
    // not. With the ignore switch off it must be reported.
    const note = await compare(page, 'value: 1', 'value: 1   ');
    expect(note, 'trailing whitespace was treated as no difference').not.toMatch(SAYS_SAME);
  });
});

test.describe('compare-text: the switches, each with its control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('ignoring case ignores case, and only case', async ({ page }) => {
    // Control first: the tool must see this difference before its absence
    // means anything.
    const before = await compare(page, 'Hello World', 'hello world');
    expect(before, 'control failed: case difference was not seen at all')
      .not.toMatch(SAYS_SAME);

    expect(await afterSwitch(page, '#ignore-case')).toMatch(SAYS_SAME);

    // And it is still only case being ignored - a real difference must
    // survive the switch, or "ignore case" has become "ignore everything".
    const stillDifferent = await compare(page, 'Hello World', 'hello there');
    expect(stillDifferent, 'ignoring case hid a difference that was not case')
      .not.toMatch(SAYS_SAME);
  });

  test('ignoring whitespace ignores whitespace, and only whitespace', async ({ page }) => {
    const before = await compare(page, 'a  b', 'a b');
    expect(before, 'control failed: whitespace difference was not seen at all')
      .not.toMatch(SAYS_SAME);

    expect(await afterSwitch(page, '#ignore-whitespace')).toMatch(SAYS_SAME);

    const stillDifferent = await compare(page, 'a  b', 'a c');
    expect(stillDifferent, 'ignoring whitespace hid a difference that was not whitespace')
      .not.toMatch(SAYS_SAME);
  });

  test('ignoring blank lines ignores blank lines, and only blank lines', async ({ page }) => {
    const before = await compare(page, 'a\n\n\nb', 'a\nb');
    expect(before, 'control failed: blank lines were not seen as a difference')
      .not.toMatch(SAYS_SAME);

    expect(await afterSwitch(page, '#ignore-blank')).toMatch(SAYS_SAME);

    const stillDifferent = await compare(page, 'a\n\n\nb', 'a\nc');
    expect(stillDifferent, 'ignoring blank lines hid a real difference')
      .not.toMatch(SAYS_SAME);
  });
});

test.describe('compare-text: the presentation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('both views show the change', async ({ page }) => {
    // Split and unified are two renderings of one answer. A view that drops
    // the change is worse than no view, because the reader concludes there
    // was not one.
    await compare(page, 'keep\nbefore\nkeep', 'keep\nafter\nkeep');

    for (const view of ['split', 'unified']) {
      await page.locator('#view').selectOption(view);
      await expect(page.locator('#diff-view'), `the ${view} view lost the change`)
        .toContainText('after');
      await expect(page.locator('#diff-view')).toContainText('before');
    }
  });

  test('swapping the sides swaps the sides', async ({ page }) => {
    await compare(page, 'left side only', 'right side only');

    await page.locator('#swap').click();
    await expect(page.locator('#input')).toHaveValue('right side only');
    await expect(page.locator('#input-b')).toHaveValue('left side only');
  });
});

test.describe('compare-text: the promise', () => {
  test('neither side ever appears in a request', async ({ page }) => {
    // People compare a config against a working one, and a contract against
    // the version they signed. Both boxes are as sensitive as each other, so
    // both are checked.
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const leftSecret = 'ghp_QAcanaryLEFT9f3e71dNotForSending';
    const rightSecret = 'ghp_QAcanaryRIGHT4a2c88eNotForSending';
    await compare(page, `token=${leftSecret}`, `token=${rightSecret}`);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the left-hand text was sent').not.toContain(leftSecret);
      expect(entry, 'the right-hand text was sent').not.toContain(rightSecret);
    }
  });
});
