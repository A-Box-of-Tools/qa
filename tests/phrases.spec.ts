import { test, expect, type Page } from '@playwright/test';
import { discoverTools } from '../lib/tools';
import { locales, localeUrl } from '../lib/locales';

/**
 * A phrase key is not a sentence, and must never reach the page as one.
 *
 * The tools keep their own sentences in the markup so a translator can reach
 * them - a hidden block of <span data-phrase="sheet.toobig">…</span> - and
 * shared/js/phrases.js looks them up by key when the script needs to say
 * something. The failure that arrangement invites is the one website #242
 * shipped and then fixed: the lookup misses, or is handed the key instead of
 * the phrase, and "gif.budget.frames" appears on screen where a sentence
 * should be.
 *
 * It is a quiet failure. The page still works, nothing throws, and the only
 * sign is a line of dotted lowercase where words should be - in a language
 * the person reading it may not be able to check against anything.
 *
 * WHAT THIS CHECKS
 *
 * Each page declares its own keys, so the test does not need a list: it reads
 * the keys out of the page's own phrase block and then requires that none of
 * them appears in what the page actually shows. The block itself is excluded,
 * being where they are supposed to be.
 *
 * At rest and after use, because #242's key was printed by a report that only
 * exists once a file has been read - which is exactly where nobody looks.
 */

/** Every key this page declares, read from its own hidden phrase block. */
async function keysOn(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-phrase]'))
      .map((el) => el.getAttribute('data-phrase') ?? '')
      .filter(Boolean));
}

/**
 * The text a visitor can actually see, with the phrase block cut out of it.
 *
 * innerText rather than textContent, so hidden elements - including the block
 * the keys live in - do not count as things anybody was shown.
 */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => (document.getElementById('main') as HTMLElement)?.innerText ?? '');
}

/** Any declared key that turned up in the visible text. */
function leaked(keys: string[], text: string): string[] {
  return keys.filter((key) => text.includes(key));
}

test.describe('no tool shows a phrase key where a sentence belongs', () => {
  for (const slug of discoverTools()) {
    test(`${slug}`, async ({ page }) => {
      await page.goto(`/${slug}/`);

      const keys = await keysOn(page);
      test.skip(keys.length === 0, 'this tool keeps no phrases of its own');

      // The control, and the reason this file is not a row of green ticks
      // that mean nothing: if the page had not rendered, no key could be
      // found in it and every test here would pass without looking at
      // anything.
      //
      // The heading rather than a length of text. How much text a tool page
      // shows at rest varies enormously - gif-analyzer is seventy-nine
      // characters and text-diff is nothing at all, being two boxes and
      // some buttons - so a threshold would fail honest pages while proving
      // very little about the rest.
      await expect(page.locator('header.topbar h1'),
        `/${slug}/ did not render`).toBeVisible();

      const showing = leaked(keys, await visibleText(page));
      expect(
        showing,
        `/${slug}/ is showing ${showing.join(', ')} where a sentence should be`,
      ).toEqual([]);
    });
  }
});

test.describe('nor after the tool has been used', () => {
  // #242's key was printed by a report that only exists once a file has been
  // read, which is the half of the page a load-time check cannot see.
  test('gif-analyzer, with a GIF in it', async ({ page }) => {
    test.setTimeout(120_000);
    const { animationFixture } = await import('../lib/gif');

    await page.goto('/gif-analyzer/');
    const keys = await keysOn(page);

    await page.locator('#file-input').setInputFiles({
      name: 'walk.gif',
      mimeType: 'image/gif',
      buffer: animationFixture(48, 32, 6).bytes,
    });

    // Wait for the report rather than a fixed pause: it is the thing under
    // examination, and it is not there at load.
    await expect
      .poll(async () => (await visibleText(page)).length, { timeout: 45_000 })
      .toBeGreaterThan(400);

    const showing = leaked(keys, await visibleText(page));
    expect(
      showing,
      `the report is printing ${showing.join(', ')} instead of what they stand for`,
    ).toEqual([]);
  });
});

test.describe('nor in the other fourteen languages', () => {
  // A missing phrase in English is caught by anybody who looks at the page. A
  // missing phrase in Korean is caught by nobody, which is why the languages
  // are worth walking rather than trusting.
  //
  // One tool, every language: the lookup is shared, so a fault in it shows
  // wherever it is used, and walking every tool in every language would be
  // five hundred page loads to learn the same thing.
  for (const lang of locales()) {
    test(`${lang} · dicom-viewer`, async ({ page }) => {
      await page.goto(localeUrl(lang, 'dicom-viewer'));

      const keys = await keysOn(page);
      test.skip(keys.length === 0, 'no phrases declared on this page');

      const showing = leaked(keys, await visibleText(page));
      expect(
        showing,
        `the ${lang} page is showing ${showing.join(', ')} rather than words`,
      ).toEqual([]);
    });
  }
});
