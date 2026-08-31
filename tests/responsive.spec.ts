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

      /*
       * The number, and - when there is one - what is making it.
       *
       * /base64/ has been failing here at eight pixels and then five, on both
       * phone projects, and does not reproduce against the same production
       * site from a developer's machine. A bare number cannot be acted on: it
       * says a page scrolls sideways without saying what is over the edge, and
       * two runs of guessing is one more than that is worth.
       *
       * So the page finds the culprit itself, by hiding one child at a time
       * and descending into whichever one made the overflow go away. It costs
       * nothing on a passing page, because it only runs when there is
       * something to explain.
       */
      const { overflow, culprit } = await page.evaluate(() => {
        const doc = document.documentElement;
        const over = doc.scrollWidth - doc.clientWidth;
        if (over <= 1) return { overflow: over, culprit: '' };

        const name = (el: Element) => {
          const one = el as HTMLElement;
          const classes = typeof one.className === 'string' && one.className.trim()
            ? `.${one.className.trim().split(/\s+/).join('.')}` : '';
          return `${el.tagName.toLowerCase()}${one.id ? `#${one.id}` : ''}${classes}`;
        };

        let node: Element = document.body;
        const trail: string[] = [];
        for (let depth = 0; depth < 12; depth += 1) {
          let found: Element | null = null;
          for (const child of Array.from(node.children)) {
            const one = child as HTMLElement;
            const was = one.style.display;
            one.style.display = 'none';
            if (doc.scrollWidth - doc.clientWidth < over) found = child;
            one.style.display = was;
            if (found) break;
          }
          if (!found) break;
          node = found;
          trail.push(name(found));
        }

        const box = (node as HTMLElement).getBoundingClientRect();
        return {
          overflow: over,
          culprit: `${trail.join(' > ') || '(nothing found)'} `
            + `[${box.left.toFixed(0)}..${box.right.toFixed(0)}, `
            + `viewport ${doc.clientWidth}]`,
        };
      });

      expect(
        overflow,
        `document is ${overflow}px wider than the viewport at ${path}: ${culprit}`,
      ).toBeLessThanOrEqual(1);
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
