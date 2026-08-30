import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';
import { quiet } from '../lib/engine';

// A deep, mistyped path - not just a bare bad slug - because the template's
// own comment on templates/404.html warns this is the one page served at an
// address it was not built for: the browser still believes it's sitting
// inside /this-tool-does-not-exist/nested/, so a relative "styles.css" would
// resolve there and 404 in its turn. Every link on this page is deliberately
// root-absolute to avoid exactly that; this spec exercises the scenario the
// comment describes rather than a shallow "some 404 page exists" check.
const BROKEN_PATH = '/this-tool-does-not-exist/nested/';

test.describe('404 page', () => {
  test('answers a missing address with a real 404 status', async ({ page }) => {
    const response = await page.goto(BROKEN_PATH);
    expect(response?.status()).toBe(404);
  });

  test('renders the site\'s own page, not a bare error, and its stylesheet actually loads', async ({ page }) => {
    const cssResponses: number[] = [];
    page.on('response', (res) => {
      if (new URL(res.url()).pathname.startsWith('/site.css')) cssResponses.push(res.status());
    });

    await page.goto(BROKEN_PATH);

    await expect(page.locator('header.hub-head h1')).toBeVisible();
    await expect(page.locator('.brand-home')).toContainText('abox.tools');
    // A relative stylesheet link would have resolved under the broken path
    // and 404'd; this is what actually proves the CSS loaded rather than
    // just that a <link> tag exists.
    expect(cssResponses, 'stylesheet response codes').toEqual([200]);
  });

  test('every link on the page is root-absolute', async ({ page }) => {
    await page.goto(BROKEN_PATH);

    const hrefs = await page.locator('a[href], link[href]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href') ?? ''),
    );

    // Fragments are exempt, and are not an oversight in the rule. What this
    // test is about is that a 404 is served at whatever depth the visitor
    // guessed, so a link written as a relative path resolves somewhere
    // different on every wrong URL. '#main' has no path to resolve: it points
    // into the page it is already on, wherever that is. The site's skip link
    // is exactly that, and it arrived as an accessibility improvement - this
    // rule flagging it was this test being too broad, not the link being
    // wrong.
    const notRootAbsolute = hrefs.filter(
      (href) => href && !href.startsWith('/') && !href.startsWith('#') && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:'),
    );

    expect(notRootAbsolute, `relative link(s) found: ${notRootAbsolute.join(', ')}`).toEqual([]);

    // Having exempted fragments from the rule above, check the thing that can
    // actually be wrong with one. A skip link is the first stop on the page
    // for a keyboard user and it is invisible to everyone else, so a broken
    // one is both serious and easy not to notice.
    const danglingFragments = await page.locator('a[href^="#"]').evaluateAll((els) =>
      els
        .map((el) => el.getAttribute('href') ?? '')
        .filter((href) => href.length > 1 && !document.getElementById(href.slice(1))),
    );

    expect(
      danglingFragments,
      `link(s) pointing at an element that does not exist: ${danglingFragments.join(', ')}`,
    ).toEqual([]);
  });

  test('lists every shipped tool, same as the hub', async ({ page }) => {
    await page.goto(BROKEN_PATH);
    await expect(page.locator('a.tool-card')).toHaveCount(discoverTools().length);
  });

  test('the home link leads back to a working hub page', async ({ page }) => {
    await page.goto(BROKEN_PATH);

    await page.locator('.brand-home').click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('a.tool-card')).toHaveCount(discoverTools().length);
  });

  test('raises no console or page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      // Chrome logs exactly this for the top-level navigation's own response
      // whenever it's a 404 - expected and unavoidable on the one page whose
      // entire purpose is answering with a 404. A real broken resource on
      // this page would log a different, resource-specific message.
      if (msg.type() === 'error' && !/^Failed to load resource: the server responded with a status of 404/.test(msg.text())) {
        errors.push(msg.text());
      }
    });

    await page.goto(BROKEN_PATH);
    await quiet(page);

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
