import { test, expect, type Page } from '@playwright/test';
import { discoverTools, hasFilePicker } from '../lib/tools';
import { encodePng } from '../lib/image-fixtures';

/**
 * Leaving a tool page happens in another tab.
 *
 * A tool page holds work in progress - a file loaded, marks placed, a result
 * computed - and a link that replaces the page throws all of it away. So on
 * this one kind of page every link away opens elsewhere, and build.py's
 * open_links_elsewhere() writes that into the rendered HTML.
 *
 * Four regions keep their tab, each for a stated reason: the header language
 * switcher and the footer language list, whose links are this same page in
 * another language and would only be duplicated by a second tab; the
 * automatic-redirect notice, which is the same; and the carry-on row, whose
 * click shared/handoff.js takes over to walk the result into the next tool.
 * Individual anchors are also left alone when they have no href, already say
 * target, stay on the page with a fragment, start a download, or open a mail
 * client.
 *
 * WHAT THIS ADDS TO THE TEST THAT ALREADY EXISTS
 *
 * etoolbox's own tests/python/test_build.py asserts this rule over every
 * built page in every language, which is the right place for it and cheaper
 * than a browser. Two things it cannot see from there, and this file can:
 *
 * Whether the page as served still says so - a stale deploy, a CDN holding an
 * older copy, or a script that adds a link after load are all invisible to a
 * check that reads the build output.
 *
 * And whether the rule does what it was written for. An attribute is a means;
 * the end is that clicking a link does not cost somebody their work. So one
 * test loads a file, clicks a link, and looks at what happened to the file.
 *
 * NOT ASSERTED: rel="noopener"
 *
 * It was, in the first draft, and it failed on the Buy Me a Coffee button -
 * which carries target="_blank" in the template, so build.py's pass leaves it
 * alone and never adds the rel beside it. But every browser this suite runs,
 * and every browser anybody reads this site in, has implied noopener for
 * target="_blank" since 2021. Failing thirty-six tool pages over a property
 * the platform now guarantees is how a suite teaches people to stop reading
 * it.
 */

/** The four regions build.py leaves alone, as a selector. */
const KEEPS_ITS_TAB = 'details.lang-pick, nav.lang-switch, div.lang-auto, nav.handoff';

type LinkRow = { href: string; target: string; rel: string; where: string };

/**
 * Every anchor that leads away from this page, and what it says about where
 * it opens.
 *
 * Anchors inside an ad slot are excluded: those are written by a script after
 * load, they are not the site's markup, and build.py could not have reached
 * them. Anything inside an iframe is in another document and out of scope
 * here by definition.
 */
async function awayLinks(page: Page): Promise<LinkRow[]> {
  return page.evaluate((keeps) => {
    const rows: LinkRow[] = [];
    for (const el of Array.from(document.querySelectorAll('a[href]'))) {
      const a = el as HTMLAnchorElement;
      const href = a.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
      if (a.hasAttribute('download')) continue;
      if (a.closest(keeps)) continue;
      if (a.closest('ins, .adsbygoogle, [data-ad-client], [id^="aswift"]')) continue;
      rows.push({
        href,
        target: a.getAttribute('target') ?? '',
        rel: a.getAttribute('rel') ?? '',
        where: a.closest('[class]')?.className?.toString().slice(0, 40) ?? '',
      });
    }
    return rows;
  }, KEEPS_ITS_TAB) as Promise<LinkRow[]>;
}

test.describe('every link away from a tool page opens elsewhere', () => {
  for (const slug of discoverTools()) {
    test(`${slug}`, async ({ page }) => {
      await page.goto(`/${slug}/`);

      const links = await awayLinks(page);

      // The control. A page whose links all happened to be exempt would pass
      // the assertion below without testing anything - and one that failed to
      // render its footer would look exactly like that.
      expect(
        links.length,
        `no links away from /${slug}/ were found at all, so this test is not `
        + 'looking at the thing it claims to check',
      ).toBeGreaterThan(3);

      const stayput = links.filter((row) => row.target !== '_blank');
      expect(
        stayput.map((row) => `${row.href} (in .${row.where})`),
        `these links on /${slug}/ would replace the page and lose whatever is loaded`,
      ).toEqual([]);

    });
  }
});

test.describe('the language links are the exception', () => {
  for (const slug of ['resize-image', 'dicom-viewer', 'share-text']) {
    test(`${slug} switches language in the same tab`, async ({ page }) => {
      await page.goto(`/${slug}/`);

      const opened = await page.evaluate((keeps) =>
        Array.from(document.querySelectorAll(`${keeps} a[href]`))
          .filter((a) => (a as HTMLAnchorElement).getAttribute('target') === '_blank')
          .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''), KEEPS_ITS_TAB);

      expect(
        opened,
        `these language links on /${slug}/ open a second tab showing the same page `
        + 'in another language, which is a duplicate rather than a destination',
      ).toEqual([]);

      // And there really are some, so the emptiness above means something.
      const count = await page.locator(`${KEEPS_ITS_TAB} a[href]`).count();
      expect(count, `no language links found on /${slug}/`).toBeGreaterThan(0);
    });
  }
});

test.describe('what the rule is for', () => {
  test('following a link away leaves the loaded file where it was', async ({ page, context }) => {
    // The point of the whole arrangement. The attribute is a means; this is
    // the end, and it is the thing that would still be broken if the
    // attribute were right and something else went wrong.
    test.setTimeout(120_000);
    const slug = discoverTools().find((tool) => hasFilePicker(tool) && tool === 'resize-image')!;

    await page.goto(`/${slug}/`);
    await page.locator('#file-input').setInputFiles({
      name: 'work-in-progress.png',
      mimeType: 'image/png',
      buffer: encodePng(200, 150, () => [200, 90, 40]),
    });
    await expect(page.locator('#crop-controls')).toBeVisible({ timeout: 30_000 });

    // A real link away: the first one the page offers that is not a language
    // link, whatever that happens to be today.
    const link = page.locator(`a[target="_blank"][href]:not(${KEEPS_ITS_TAB} a)`).first();
    await expect(link).toHaveCount(1);

    const before = page.url();
    const [fresh] = await Promise.all([
      context.waitForEvent('page', { timeout: 30_000 }),
      link.click(),
    ]);

    // The new tab exists, and the old one has not moved.
    expect(fresh).toBeTruthy();
    expect(page.url(), 'the tool page navigated away instead of opening a tab').toBe(before);

    // And the work is still there, which is the whole reason for the rule.
    await expect(
      page.locator('#crop-controls'),
      'the loaded file was lost when a link was followed',
    ).toBeVisible();

    await fresh.close();
  });
});
