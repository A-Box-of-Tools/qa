import { test, expect, type Page } from '@playwright/test';
import { discoverTools } from '../lib/tools';

/**
 * The hub's filter, and the three rules shared/hub-filter.js sets itself.
 *
 *   1. Nothing leaves the page. It reads the cards the build already wrote
 *      and hides the ones that do not match. Its own comment is the reason
 *      this is tested first: "a search box is the control a visitor most
 *      reasonably expects to be wired to somebody's server, so on this site
 *      of all sites it has to be obviously not."
 *   2. Nothing is remembered. No history entry, no query string, no storage.
 *      A way of looking at one page, not a preference.
 *   3. It is an enhancement, strictly. The field carries `hidden` in the
 *      markup and the script is the only thing that reveals it, so a visitor
 *      with JavaScript off gets the page as it was rather than a search box
 *      that does nothing.
 *
 * All three are the kind of promise that keeps working long after it has
 * stopped being true, which is what makes them worth a test rather than a
 * comment.
 */

const FILTER = '#tool-filter-input';
const NONE = '#tool-filter-none';

/** Tools whose cards are on screen right now. */
async function shown(page: Page): Promise<number> {
  return page.locator('.tool-card:visible, li.tool:visible, .tool-list li:visible').count();
}

/** Type into the filter and let it settle - it debounces its own keystrokes. */
async function filter(page: Page, query: string): Promise<void> {
  await page.locator(FILTER).fill(query);
  await page.waitForTimeout(400);
}

test.describe('the hub filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // The script reveals it; if it is still hidden the enhancement did not
    // arrive and every test below would be testing a field nobody can use.
    await expect(page.locator(FILTER)).toBeVisible({ timeout: 20_000 });
  });

  test('narrows the page to what was asked for', async ({ page }) => {
    const before = await shown(page);
    expect(before, 'no tool cards were found to filter').toBeGreaterThan(10);

    await filter(page, 'pdf');
    const after = await shown(page);

    expect(after, 'typing changed nothing').toBeLessThan(before);
    expect(after, 'typing hid everything').toBeGreaterThan(0);

    // What is left really is what was asked for. Checked against the visible
    // text rather than a list kept here, because the point is what a reader
    // sees rather than what the build knows.
    const names = await page.locator('.tool-card:visible, li.tool:visible, .tool-list li:visible')
      .allTextContents();
    for (const name of names) {
      expect(
        name.toLowerCase(),
        `"${name.trim().slice(0, 40)}" is on screen after filtering for pdf`,
      ).toContain('pdf');
    }
  });

  test('clearing it puts every tool back', async ({ page }) => {
    const before = await shown(page);
    await filter(page, 'pdf');
    expect(await shown(page)).toBeLessThan(before);

    await filter(page, '');
    expect(await shown(page), 'clearing the box did not restore the page').toBe(before);
  });

  test('a query that matches nothing says so', async ({ page }) => {
    await filter(page, 'zzzznotatoolzzzz');

    expect(await shown(page), 'something matched a query that should match nothing').toBe(0);
    await expect(page.locator(NONE), 'nothing on the page said the search found nothing')
      .toBeVisible();

    // And it goes away again, so the message is about this search rather than
    // a thing the page now permanently says.
    await filter(page, '');
    await expect(page.locator(NONE)).toBeHidden();
  });

  test('Escape clears it, and the slash key reaches it', async ({ page }) => {
    await filter(page, 'pdf');
    await page.locator(FILTER).press('Escape');
    await page.waitForTimeout(300);
    await expect(page.locator(FILTER)).toHaveValue('');

    // The shortcut every search field on a code-hosting site has. Pressed
    // with the focus elsewhere, because that is the only state it is for.
    await page.locator('body').click();
    await page.keyboard.press('/');
    await expect(page.locator(FILTER)).toBeFocused();
  });

  test('every tool can be found by its own name', async ({ page }) => {
    // The filter matches the name, the one-line description and the category.
    // A tool that cannot be found by typing its own name is invisible to the
    // one search anybody would actually run.
    test.setTimeout(180_000);
    const missing: string[] = [];

    for (const slug of discoverTools()) {
      // The slug is not the name, but it is made from it, and the words in it
      // are the words on the card.
      const word = slug.split('-')[0];
      await filter(page, word);
      if (await shown(page) === 0) missing.push(`${slug} (searched "${word}")`);
    }

    expect(missing, `these tools matched nothing: ${missing.join(', ')}`).toEqual([]);
  });
});

test.describe('the hub filter: the rules it sets itself', () => {
  test('nothing leaves the page while somebody types', async ({ page }) => {
    // Rule one, and the one the file argues for at length. A search box that
    // quietly asked a server what matched would look and behave exactly like
    // this one.
    await page.goto('/');
    await expect(page.locator(FILTER)).toBeVisible({ timeout: 20_000 });

    const traffic: string[] = [];
    page.on('request', (req) => {
      const host = new URL(req.url()).host;
      // The page's own third parties are already accounted for elsewhere; a
      // filter that phoned home would phone this site.
      if (host === new URL(page.url()).host) traffic.push(`${req.method()} ${req.url()}`);
    });

    for (const query of ['p', 'pd', 'pdf', 'pdfx']) {
      await page.locator(FILTER).fill(query);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(1000);

    expect(
      traffic,
      `typing in the filter made ${traffic.length} request(s) to this site: ${traffic.join(', ')}`,
    ).toEqual([]);
  });

  test('nothing is remembered', async ({ page }) => {
    // Rule two. A filter that wrote to the URL would put the tool somebody
    // searched for into their history, and one that wrote to storage would
    // carry it to the next visit.
    await page.goto('/');
    await expect(page.locator(FILTER)).toBeVisible({ timeout: 20_000 });

    const address = page.url();
    const entries = await page.evaluate(() => history.length);

    await filter(page, 'redact');

    expect(page.url(), 'the search was written into the address').toBe(address);
    expect(await page.evaluate(() => history.length), 'the search added a history entry')
      .toBe(entries);

    const remembered = await page.evaluate(() => ({
      local: Object.keys(localStorage).filter((k) => /filter|search|query/i.test(k)),
      session: Object.keys(sessionStorage).filter((k) => /filter|search|query/i.test(k)),
    }));
    expect(remembered.local, 'the search was kept in localStorage').toEqual([]);
    expect(remembered.session, 'the search was kept in sessionStorage').toEqual([]);
  });

  test('it is an enhancement: the markup ships it hidden', async ({ page }) => {
    // Rule three, checked from the other side. With the script blocked the
    // page must be the page it was - not a search box that does nothing,
    // which is the failure this rule exists to prevent.
    await page.route(/hub-filter/, (route) => route.abort());
    await page.goto('/');

    await expect(
      page.locator('#tool-filter'),
      'the filter is visible without the script that makes it work',
    ).toBeHidden();

    // And the page is still usable: the tools are all there to be read.
    expect(await shown(page), 'the tools went missing when the filter script did')
      .toBeGreaterThan(10);
  });
});
