import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';
import { quiet, withoutThirdParties } from '../lib/engine';

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

});

/*
 * The hub loads three scripts nobody here wrote - AdSense, the Google tag,
 * and the Buy Me a Coffee button - and they are refused for the length of
 * this test.
 *
 * Not to make it pass. To make it mean something. What it kept catching was
 * `Unhandled Promise Rejection: undefined`, on WebKit: a rejection with no
 * reason, no stack and no origin, which cannot be attributed, cannot be acted
 * on, and is not this site's to fix. A suite that fails on somebody else's
 * script teaches everyone to skim its failures, which costs more than this
 * test is worth. So the question it asks is the answerable one: does the code
 * in this repository raise anything when the hub loads.
 *
 * Refused rather than left out of the assertion, because the two are not the
 * same. Filtering would leave their errors uncounted while their side effects
 * stayed on the page; this way nothing of theirs runs at all, and anything
 * that then goes wrong is ours.
 *
 * Answered with an empty script rather than aborted. An abort is a failed
 * request, and a failed request is a console error - three of them, which
 * this test would then have counted as the very thing it is looking for.
 *
 * IN ITS OWN DESCRIBE, AND WHY
 *
 * This test used to sit with the others, under a beforeEach that loads the
 * hub, and then refuse the three scripts and reload. Refusing them did not
 * stop the failure, and the recorder below - installed before any script -
 * never once saw the rejection. Both for the same reason: the first load, the
 * one beforeEach made, ran those three scripts for real, and the reload tore
 * that document down while their work was in flight. The rejection was that
 * document's, and nothing of ours was listening in it; it reached this test
 * only because `pageerror` reports whatever the page raises, whichever
 * document it was. It came and went with what the ad network happened to
 * serve and how far it had got, which is what "intermittent, on WebKit"
 * looked like from outside. Give the test time before reloading - waiting
 * for the offline worker, say - and it failed every time.
 *
 * So the hub is loaded once, here, with the three scripts already refused
 * and the recorder already in place. There is no first document to tear
 * down, and nothing on the page that is not this repository's.
 */
test.describe('hub page, loaded once with nothing of anybody else\'s', () => {
  test('raises no console or page errors while loading', async ({ page }) => {
    await withoutThirdParties(page);

    /*
     * A rejected promise reaches `pageerror` as the string "Unhandled Promise
     * Rejection: undefined" and nothing else - no reason, no stack, no script
     * that raised it. This listener is installed before any script on the
     * page and writes down what the browser knows at the moment of rejection
     * - the reason's own stack where there is one, its type and text where
     * there is not - so a failure arrives with something in it to act on.
     */
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __rejections: string[] }).__rejections = seen;
      window.addEventListener('unhandledrejection', (event) => {
        const why = (event as PromiseRejectionEvent).reason;
        if (why === undefined || why === null) {
          seen.push(`rejected with ${String(why)}; no stack. Script that was running: `
            + `${document.currentScript?.getAttribute('src') ?? 'none named'}`);
        } else if (why instanceof Error) {
          seen.push(`${why.name}: ${why.message}\n${why.stack ?? 'no stack'}`);
        } else {
          seen.push(`rejected with ${typeof why}: ${String(why).slice(0, 300)}`);
        }
      });
    });

    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await quiet(page);

    // The control. With every request routed there is a way to break this
    // test into one that loads nothing and therefore reports nothing, and it
    // would look exactly like a pass.
    await expect(page.locator('a.tool-card').first()).toBeVisible();

    const detail = await page.evaluate(
      () => (window as unknown as { __rejections?: string[] }).__rejections ?? [],
    );
    expect(
      errors,
      [...errors, ...(detail.length ? ['', 'what the page knew about it:', ...detail] : [])]
        .join('\n'),
    ).toEqual([]);
  });
});
