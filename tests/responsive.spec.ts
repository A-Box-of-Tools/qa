import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';

// The hub plus a small, evenly-spread sample of tools - enough to catch a
// layout rule that only breaks one category, without doubling total runtime
// by walking all ~30 pages at both viewports for a check this cheap.
const tools = discoverTools();
const sample = tools.filter((_, i) => i % 4 === 0);
const paths = ['/', ...sample.map((slug) => `/${slug}/`)];

test.describe('responsive layout', () => {
  for (const path of paths) {
    test(`no horizontal overflow at this viewport: ${path}`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      });
      expect(overflow, `document is ${overflow}px wider than the viewport at ${path}`).toBeLessThanOrEqual(1);
    });
  }

  test('the drop zone stays visible and large enough to tap', async ({ page }) => {
    await page.goto(`/${tools[0]}/`);
    const box = await page.locator('label#dropzone').boundingBox();
    expect(box, 'drop zone has no layout box - is it hidden at this viewport?').not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    // ~44px is the common minimum recommended touch-target size (WCAG 2.5.5 /
    // Apple HIG); desktop happens to clear it too, so one assertion covers
    // both projects.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test('header actions do not overlap at this viewport', async ({ page }) => {
    await page.goto(`/${tools[0]}/`);
    const actions = page.locator('.topbar-actions');
    await expect(actions).toBeVisible();
    const overlapsPledge = await page.evaluate(() => {
      const actionsEl = document.querySelector('.topbar-actions');
      const pledgeEl = document.querySelector('.pledge');
      if (!actionsEl || !pledgeEl) return false;
      const a = actionsEl.getBoundingClientRect();
      const p = pledgeEl.getBoundingClientRect();
      return a.bottom > p.top && a.top < p.bottom && a.right > p.left && a.left < p.right;
    });
    expect(overlapsPledge).toBe(false);
  });
});

/**
 * The language switcher's menu, opened.
 *
 * The overflow test above measures the document with everything closed, which
 * is the state a page is in when nobody is using it. A menu that is absolutely
 * positioned does not widen the document when it hangs off the side - it is
 * simply clipped - so the check above cannot see this and did not: the menu
 * sat forty-two pixels past the left edge of a 393-pixel phone, with every
 * language name cut in half, and the suite called the page green.
 *
 * The people this fails are exactly the people who need it. Somebody reaching
 * for the language switcher is telling you they cannot read the page they are
 * on, and what they got was a column of half-words.
 *
 * Measured rather than eyeballed, and measured on a tool page as well as the
 * hub, because the switcher lives in the shared frame and a rule that fixes
 * one is meant to fix all of them.
 */
test.describe('the language menu stays on screen', () => {
  for (const path of ['/', '/redact-image/', '/resize-image/']) {
    test(`opened, it fits within the viewport: ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.locator('details.lang-pick summary').first().click();

      const menu = page.locator('.lang-pick-menu').first();
      await expect(menu).toBeVisible();

      const box = await menu.boundingBox();
      const width = page.viewportSize()?.width ?? 0;
      expect(box, 'the menu has no box to measure').not.toBeNull();

      // Half a pixel of slack for subpixel layout, and no more: this is about
      // whole words being unreadable, not hairlines.
      expect(
        box!.x,
        `the menu starts ${Math.round(box!.x)}px from the left edge, so its first `
        + `${Math.round(-box!.x)}px are off screen and the language names are cut off`,
      ).toBeGreaterThanOrEqual(-0.5);

      expect(
        box!.x + box!.width,
        `the menu ends ${Math.round(box!.x + box!.width - width)}px past the right edge `
        + `of a ${width}px viewport`,
      ).toBeLessThanOrEqual(width + 0.5);
    });
  }
});
