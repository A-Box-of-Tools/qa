import { test, expect, type Page } from '@playwright/test';
import { discoverTools } from '../lib/tools';

/**
 * Every fold on the site answers both the pointer and the keyboard.
 *
 * Website #255 made that true and is worth a test because of what it found
 * on the way: of the nine tools that write their own fold, three gave no
 * hover feedback at all and six changed colour under the pointer - and NONE
 * of them answered :focus-visible. Nor did the questions accordion, the
 * language switcher, or the pledge caret in the shared frame, which every
 * page on the site inherits.
 *
 * A summary that lights up under a mouse and does nothing under Tab tells
 * half its readers where they are. It is also the half of the rule most
 * likely to come back: hover is what an author notices while building a
 * page, and focus is what they do not.
 *
 * WHAT COUNTS AS AN ANSWER
 *
 * Anything a reader could see: the text colour, the background, the border,
 * or an outline. The test does not care which - that is the designer's
 * business and it changes - only that the summary looks different from the
 * way it looks at rest. Comparing against the element's own resting style
 * rather than an expected value is what keeps this from being a screenshot
 * test that fails every time somebody picks a different blue.
 */

/** The properties a reader would notice a change in. */
const NOTICEABLE = ['color', 'backgroundColor', 'borderColor', 'outlineWidth', 'outlineColor'];

type Fold = { where: string; restingAndFocused: boolean };

/**
 * Every summary on the page, focused in turn, reporting the ones that look
 * exactly the same focused as they do at rest.
 *
 * Tab is pressed once first. :focus-visible is a heuristic about how the
 * visitor is driving the page, and Chromium will not apply it to a
 * programmatic focus() until it believes a keyboard is in use - so without
 * that keystroke every summary would look unanswered and this file would
 * report the whole site as broken.
 */
async function unansweredByKeyboard(page: Page): Promise<string[]> {
  await page.keyboard.press('Tab');
  return page.evaluate((props) => {
    // That keystroke landed somewhere, and in WebKit "somewhere" is often the
    // first fold on the page - so the resting reading would be taken from an
    // element that is already focused, match its focused reading exactly, and
    // report the site as giving no feedback at all. It reported forty folds
    // that way before this line. Chromium happens to put the first tab stop
    // elsewhere, which is luck rather than a difference worth encoding.
    (document.activeElement as HTMLElement | null)?.blur();

    // The whole summary: itself, the marks it draws, and everything inside
    // it. Feedback lands in all three places on this site - ::after for the
    // step notes, a child .pledge-caret for the pledge, a child h2 for the
    // how-to heading - and a reading narrower than the subtree reports a fold
    // as silent when it is only answering somewhere else. This is the third
    // time this function was too narrow, which is the argument for reading
    // everything rather than guessing where the designer put it.
    const readOne = (el: Element) => [undefined, '::before', '::after']
      .map((part) => {
        const style = getComputedStyle(el, part);
        return props.map((name) => style[name as keyof CSSStyleDeclaration] as string).join('|');
      }).join('||');
    const read = (el: Element) => [el, ...Array.from(el.querySelectorAll('*'))]
      .map(readOne).join('###');

    const missing: string[] = [];
    for (const el of Array.from(document.querySelectorAll('summary'))) {
      if ((el as HTMLElement).offsetParent === null) continue; // not on screen
      const rest = read(el);
      (el as HTMLElement).focus();

      // A fold inside a card the tool has not activated yet is `inert`, and
      // an inert subtree cannot take focus at all - crop-video's "3 Crop it"
      // is on screen and unreachable until a video is loaded. Asking such a
      // fold to look different when focused is asking it to do something no
      // reader can make it do, and the first draft of this file reported nine
      // tools as broken on exactly that.
      if (document.activeElement !== el) continue;

      const focused = read(el);
      (el as HTMLElement).blur();

      if (rest === focused) {
        const label = (el.textContent ?? '').trim().slice(0, 40) || el.className || 'a summary';
        missing.push(label);
      }
    }
    return missing;
  }, NOTICEABLE);
}

test.describe('folds answer the keyboard', () => {
  for (const slug of discoverTools()) {
    test(`${slug}`, async ({ page }) => {
      await page.goto(`/${slug}/`);

      // The control. A page with no folds on it proves nothing, and a
      // selector that stopped matching would look exactly like a page that
      // passed.
      const count = await page.locator('summary:visible').count();
      expect(count, `/${slug}/ has no folds to check`).toBeGreaterThan(0);

      const silent = await unansweredByKeyboard(page);
      expect(
        silent,
        `these folds on /${slug}/ look the same focused as at rest, so a reader `
        + `arriving by Tab cannot see where they are: ${silent.join(' | ')}`,
      ).toEqual([]);
    });
  }
});

test.describe('folds answer the pointer too', () => {
  // Hover needs a real pointer, so this is a sample rather than every page:
  // the frame's folds are on all of them, and these three carry the
  // tool-written ones the change was about.
  for (const slug of ['password-generator', 'gif-analyzer', 'compress-pdf']) {
    test(`${slug}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(`/${slug}/`);

      const folds = page.locator('summary:visible');
      const total = await folds.count();
      expect(total, `/${slug}/ has no folds to check`).toBeGreaterThan(0);

      const silent: string[] = [];
      for (let i = 0; i < Math.min(total, 8); i += 1) {
        const fold = folds.nth(i);
        // Same exemption as above: an inert card's fold answers nothing,
        // correctly, because nothing can reach it yet.
        if (await fold.evaluate((el) => !!el.closest('[inert]'))) continue;
        const subtree = (el: Element, props: string[]) => {
          const one = (node: Element) => [undefined, '::before', '::after']
            .map((part) => {
              const st = getComputedStyle(node, part as string);
              return props.map((n) => st[n as keyof CSSStyleDeclaration] as string).join('|');
            }).join('||');
          return [el, ...Array.from(el.querySelectorAll('*'))].map(one).join('###');
        };
        const rest = await fold.evaluate(subtree, NOTICEABLE);

        await fold.hover();
        // These marks fade rather than snap - the shared rule transitions
        // colour, background and border, which #255 mentions because
        // password-generator's private copy transitioned only the first and
        // so snapped where everything else faded. getComputedStyle during a
        // transition returns the value part-way along it, which right after
        // the pointer arrives is still the resting one; sampling there
        // reported every fold on the site as answering nothing.
        await page.waitForTimeout(400);
        const hovered = await fold.evaluate(subtree, NOTICEABLE);

        if (rest === hovered) {
          silent.push(((await fold.textContent()) ?? '').trim().slice(0, 40));
        }
      }

      expect(
        silent,
        `these folds on /${slug}/ do not change under the pointer: ${silent.join(' | ')}`,
      ).toEqual([]);
    });
  }
});

test.describe('a fold is a fold wherever it lives', () => {
  test('the frame\'s own folds answer the keyboard on the hub as well', async ({ page }) => {
    // The questions accordion, the language switcher and the pledge caret are
    // the frame's, not a tool's, and #255 found none of them answering either.
    // The hub carries them without a tool underneath, which is the one place
    // a tool-page-only rule would miss.
    await page.goto('/');

    const count = await page.locator('summary:visible').count();
    expect(count, 'the hub has no folds to check').toBeGreaterThan(0);

    const silent = await unansweredByKeyboard(page);
    expect(
      silent,
      `these folds on the hub look the same focused as at rest: ${silent.join(' | ')}`,
    ).toEqual([]);
  });
});
