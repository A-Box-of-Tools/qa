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
