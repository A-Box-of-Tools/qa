import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';
import { quiet } from '../lib/engine';

const tools = discoverTools();

test.describe('hub page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('lists every shipped tool exactly once', async ({ page }) => {
    await expect(page.locator('a.tool-card')).toHaveCount(tools.length);
  });

  test('every tool card points at a slug that actually exists', async ({ page }) => {
    const hrefs = await page.locator('a.tool-card').evaluateAll((els) =>
      els.map((el) => el.getAttribute('href') ?? ''),
    );
    const slugs = hrefs.map((h) => h.replace(/\/$/, '')).sort();
    expect(slugs).toEqual(tools);
  });

  test('language switcher opens and offers at least one alternate', async ({ page }) => {
    const picker = page.locator('details.lang-pick').first();
    await expect(picker).toBeVisible();
    await picker.locator('summary').click();
    await expect(picker.locator('.lang-pick-menu a').first()).toBeVisible();
  });

  test('switching language navigates there and updates the page', async ({ page }) => {
    // Arabic exercises the one locale that also flips text direction, which
    // is the strongest single check that this does more than change the URL.
    const picker = page.locator('details.lang-pick').first();
    await picker.locator('summary').click();

    const arabic = picker.locator('a[hreflang="ar"]');
    const href = await arabic.getAttribute('href');
    await arabic.click();

    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

    // The switcher on the Arabic page should mark Arabic itself as current
    // (not a link) and offer a plain link back to English.
    const backPicker = page.locator('details.lang-pick').first();
    await backPicker.locator('summary').click();
    await expect(backPicker.locator('.lang-current[lang="ar"]')).toBeVisible();
    await expect(backPicker.locator('a[hreflang="en"]')).toBeVisible();
  });

  test('footer carries the source link and a full tool list', async ({ page }) => {
    await expect(page.locator('footer a[href*="github.com"]').first()).toBeVisible();
    const footerToolLinks = page.locator('footer .footer-col ul li a');
    await expect(footerToolLinks).not.toHaveCount(0);
  });

  test('opening the first tool card lands on that tool\'s own page', async ({ page }) => {
    const firstCard = page.locator('a.tool-card').first();
    const slug = (await firstCard.getAttribute('href'))!.replace(/\/$/, '');

    await firstCard.click();

    await expect(page).toHaveURL(new RegExp(`/${slug}/?$`));
    await expect(page.locator('header.topbar h1')).toBeVisible();
    await expect(page.locator('nav.crumbs [aria-current="page"]')).toBeVisible();
  });

  /*
   * The hub loads three scripts nobody here wrote - AdSense, the Google tag,
   * and the Buy Me a Coffee button - and they are refused for the length of
   * this test.
   *
   * Not to make it pass. To make it mean something. What it kept catching was
   * `Unhandled Promise Rejection: undefined`, on WebKit, from one of those
   * three: a rejection with no reason, no stack and no origin, which cannot be
   * attributed, cannot be acted on, and is not this site's to fix. It failed
   * on Mobile Safari one night and Desktop Safari the next, which is what a
   * third party having a bad minute looks like.
   *
   * A suite that fails on somebody else's script teaches everyone to skim its
   * failures, which costs more than this test is worth. So the question it
   * asks is the answerable one: does the code in this repository raise
   * anything when the hub loads.
   *
   * Refused rather than left out of the assertion, because the two are not the
   * same. Filtering would leave their errors uncounted while their side
   * effects stayed on the page; this way nothing of theirs runs at all, and
   * anything that then goes wrong is ours.
   *
   * Answered with an empty script rather than aborted. An abort is a failed
   * request, and a failed request is a console error - three of them, which
   * this test would then have counted as the very thing it is looking for.
   */
  const OTHERS = [
    'googlesyndication.com',
    'googletagmanager.com',
    'google-analytics.com',
    'buymeacoffee.com',
  ];

  test('raises no console or page errors while loading', async ({ page }) => {
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (OTHERS.some((host) => url.includes(host))) {
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
      }
      return route.continue();
    });

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.reload();
    await quiet(page);

    // The control. With every request routed there is a way to break this
    // test into one that loads nothing and therefore reports nothing, and it
    // would look exactly like a pass.
    await expect(page.locator('a.tool-card').first()).toBeVisible();

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
