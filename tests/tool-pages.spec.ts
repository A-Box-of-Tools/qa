import { test, expect } from '@playwright/test';
import { allowedExternalHosts, isKnownBenignHost } from '../lib/csp';
import { BASE_URL } from '../lib/site';
import { discoverTools, hasFilePicker } from '../lib/tools';
import { quiet, withoutThirdParties } from '../lib/engine';

// One test.describe per shipped tool, discovered from the etoolbox checkout
// itself (see lib/tools.ts) - add a tool there and it is covered here with
// no list to update in this repo.
//
// Three tests a tool, and three page loads, where there were five of each:
// the static checks - the frame, the drop zone, the privacy panel - read one
// page and are steps of one test, because a page loaded three times to look
// at three parts of it was the single largest cost in the suite (164 tools
// and projects, three loads each, on an engine that takes five seconds a
// load). The two that must listen from before the load each take their own.
for (const slug of discoverTools()) {
  test.describe(`tool: ${slug}`, () => {
    test('renders the frame, the drop zone and the privacy panel', async ({ page }) => {
      await page.goto(`/${slug}/`);

      await test.step('the frame and the tool\'s own heading', async () => {
        await expect(page).toHaveTitle(/.+/);
        await expect(page.locator('header.topbar h1')).toBeVisible();
        await expect(page.locator('nav.crumbs [aria-current="page"]')).toBeVisible();
      });

      // password-generator and qr-barcode generate a file rather than take
      // one, so they never include the shared drop-zone widget - see
      // lib/tools.ts - and this step is not theirs.
      if (hasFilePicker(slug)) {
        await test.step('a working, keyboard-reachable drop zone', async () => {
          const dropzone = page.locator('label#dropzone');
          const input = page.locator('input#file-input');
          await expect(dropzone).toBeVisible();
          await expect(input).toHaveCount(1);
          // The <label>/<input> pairing is what makes the zone clickable
          // without JS at all (see templates/partials/file-picker.html) -
          // verify the pairing itself, not just that both elements exist
          // somewhere.
          await expect(dropzone).toHaveAttribute('for', (await input.getAttribute('id'))!);
        });
      }

      await test.step('the privacy panel opens from the header toggle', async () => {
        const toggle = page.locator('#privacy-toggle');
        const panel = page.locator('#privacy-panel');

        await expect(panel).toBeHidden();
        await toggle.click();
        await expect(panel).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      });
    });

    test('boots cleanly: no JS error, no-JS warning stays hidden', async ({ page }) => {
      // This site's code, not the ad network's. gif-maker failed here on
      // Mobile Safari with an ad iframe complaining that "https://abox.tools"
      // may not touch a frame from doubleclick.net - true, and nothing this
      // repository can do about it. Those scripts are answered by nothing
      // before the page loads, so what is counted below is ours; the CSP
      // test below still watches the real requests.
      await withoutThirdParties(page);

      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(String(err)));

      await page.goto(`/${slug}/`);
      await quiet(page);

      expect(errors, errors.join('\n')).toEqual([]);
      await expect(page.locator('#boot-warning')).toBeHidden();
    });

    test('contacts no host outside this site\'s declared CSP allowlist', async ({ page }) => {
      const allowed = allowedExternalHosts();
      const ownHost = new URL(BASE_URL).host;
      const unexpected = new Set<string>();

      page.on('request', (req) => {
        // Only the top document's own requests: a CSP governs what a page
        // may load and which origins it may embed as a frame, but it has no
        // say over what an already-embedded cross-origin iframe's own script
        // then does internally - that traffic answers to the iframe's own
        // origin, not this policy. Google's ad frames make exactly this kind
        // of request (observed: an ad frame reporting to
        // csp.withgoogle.com on mobile), and it isn't something site.toml's
        // [csp] table was ever able to prevent.
        if (req.frame() !== page.mainFrame()) return;

        const host = new URL(req.url()).host;
        // A URL with no host is not a host this page contacted: data:, blob:
        // and about: are the page's own bytes, and handing a result around as
        // a data URI is what several of these tools do for a living. WebKit
        // reports them as requests where Chromium does not, which turned an
        // engine difference into eight tools apparently phoning "" home.
        if (!host) return;
        if (host === ownHost) return;
        if (isKnownBenignHost(host)) return;
        for (const allowedHost of allowed) {
          if (host === allowedHost || host.endsWith(`.${allowedHost}`)) return;
        }
        unexpected.add(host);
      });

      await page.goto(`/${slug}/`);
      await quiet(page);

      expect(
        [...unexpected],
        `page contacted host(s) not in config/site.toml's [csp] table: ${[...unexpected].join(', ')}`,
      ).toEqual([]);
    });
  });
}
