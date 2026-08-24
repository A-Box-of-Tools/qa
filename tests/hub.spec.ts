import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';

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

  test('raises no console or page errors while loading', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.reload();
    await page.waitForLoadState('networkidle');

    expect(errors, errors.join('\n')).toEqual([]);
  });
});
