import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';

/*
 * Every button a thumb can see is at least 44px tall.
 *
 * The frame promises this under a coarse pointer (shared/css/tool-frame.css,
 * `@media (pointer: coarse)`), after a survey found twenty-nine of forty-one
 * tools with buttons between 30 and 37px on a phone - a ghost button at 34,
 * the trim tools' private scale at 31 - because no rule set a floor and each
 * tool chose its own padding. Forty-four is the number Apple's guidance and
 * the WCAG target-size criterion agree on.
 *
 * The check walks every page at load, on the two phone projects only: a
 * desktop window is driven by a mouse and the floor does not apply there,
 * which the page itself reports through the same media query the CSS uses.
 * Links dressed as buttons count too; the frame lays them out as boxes under
 * a coarse pointer for exactly this reason. What is hidden at load - the
 * controls of a step that opens once a file is chosen - is not measured,
 * because a hidden control has no height to measure; the tool specs that
 * load a file are where those are seen.
 */

const paths = ['/', ...discoverTools().map((slug) => `/${slug}/`)];

test.describe('tap targets', () => {
  for (const path of paths) {
    test(`every visible button is at least 44px tall: ${path}`, async ({ page, isMobile }) => {
      test.skip(!isMobile, 'the floor applies under a coarse pointer, which only the phone projects have');

      await page.goto(path);

      const { coarse, short } = await page.evaluate(() => {
        const name = (el: Element) => {
          const one = el as HTMLElement;
          const classes = typeof one.className === 'string' && one.className.trim()
            ? `.${one.className.trim().split(/\s+/).join('.')}` : '';
          const text = (one.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
          return `${el.tagName.toLowerCase()}${one.id ? `#${one.id}` : ''}${classes}${text ? ` "${text}"` : ''}`;
        };

        const short: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a.as-button'))) {
          const rect = el.getBoundingClientRect();
          // Not on the page at all: inside a hidden step, or laid out away.
          if (rect.width === 0 && rect.height === 0) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          if (rect.height < 44) short.push(`${name(el)} is ${Math.round(rect.height)}px`);
        }
        return { coarse: matchMedia('(pointer: coarse)').matches, short };
      });

      // The floor is gated on the pointer, so a project that does not report
      // one would pass vacuously; say so instead.
      expect(coarse, 'this project should present a coarse pointer').toBe(true);
      expect(short, 'buttons under the 44px touch floor').toEqual([]);
    });
  }
});
