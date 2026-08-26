import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { discoverTools, hasFilePicker } from '../lib/tools';
import { ETOOLBOX_DIR } from '../lib/site';
import { encodePng } from '../lib/image-fixtures';
import { writeDicom } from '../lib/dicom';

/**
 * Accessibility, in four passes.
 *
 * 1. Every page, scanned by axe at load - all the tools, the hub in both its
 *    directions, the guides, the legal pages, the roadmap and the 404. This
 *    used to sample every fifth tool to keep one runner's time down; the
 *    suite is sharded now and the constraint is gone with it.
 *
 * 2. The states axe never sees at load. A tool page opens as a file picker
 *    and some prose, and most of its interface - results, errors, panels -
 *    only exists after somebody acts. A page can pass every scan in its empty
 *    state and still show its results as unlabelled soup.
 *
 * 3. Dark mode. Contrast is checked against rendered colours, and the site
 *    renders two different sets of them.
 *
 * 4. The keyboard. The file-picker partial makes a specific claim in its own
 *    comment: the input stays in the layout, "visually hidden, still
 *    focusable, and reachable by keyboard. There is no JavaScript in that
 *    path at all." Reachable is testable: press Tab until it is reached.
 *
 * Serious and critical violations only, throughout. The moderate tier is
 * real but noisy, and a gate people mute is worse than a narrower gate they
 * keep.
 */

const TOOLS = discoverTools();

/** The first guide on disk, so one full prose page is always in the scan. */
function firstGuide(): string {
  const guides = path.join(ETOOLBOX_DIR, 'pages', 'guides');
  const slug = fs.readdirSync(guides, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()[0];
  return `/guides/${slug}/`;
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

async function expectClean(page: Page): Promise<void> {
  const violations = await seriousViolations(page);
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

/* ------------------------------------------------------- 1. every page */

const PAGES: string[] = [
  '/',
  '/ar/', // the RTL direction: dir, lang and hreflang all differ from '/'
  ...TOOLS.map((slug) => `/${slug}/`),
  '/guides/',
  firstGuide(),
  '/roadmap/',
  '/privacy/',
  '/terms/',
  '/this-tool-does-not-exist/', // the 404, which renders a full page of its own
];

test.describe('axe: every page, at load', () => {
  for (const pagePath of PAGES) {
    test(`clean: ${pagePath}`, async ({ page }) => {
      await page.goto(pagePath);
      await expectClean(page);
    });
  }
});

/* ------------------------------------- 2. the states axe never sees at load */

test.describe('axe: the states a visitor actually reaches', () => {
  test('a tool with a file loaded, and with its results shown', async ({ page }) => {
    // Two scans in one journey: the editing state and the results state.
    // Both interfaces exist only now - at load they are `hidden` subtrees
    // that axe does not evaluate.
    test.setTimeout(120_000);
    await page.goto('/resize-image/');
    await page.locator('#file-input').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: encodePng(320, 240, () => [90, 120, 200]),
    });
    await expect(page.locator('#crop-controls')).toBeVisible({ timeout: 30_000 });
    await expectClean(page);

    await page.locator('#run').click();
    await expect(page.locator('#results')).toBeVisible({ timeout: 60_000 });
    await expectClean(page);
  });

  test('a tool showing its load error', async ({ page }) => {
    // The error path is the one state everybody eventually sees, and an
    // unannounced or low-contrast error is exactly the failure a load-time
    // scan cannot catch.
    await page.goto('/resize-image/');
    await page.locator('#file-input').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('these bytes are not a picture', 'latin1'),
    });
    await expect(page.locator('#load-error')).toBeVisible({ timeout: 30_000 });
    await expectClean(page);
  });

  test('the DICOM viewer with a scan open', async ({ page }) => {
    // The richest interface on the site once a file is in: the identity
    // panel, the tag table, the window controls, the overlays.
    test.setTimeout(120_000);
    await page.goto('/dicom-viewer/');
    await page.locator('#file-input').setInputFiles({
      name: 'scan.dcm',
      mimeType: 'application/dicom',
      buffer: writeDicom(),
    });
    await expect(page.locator('#identity-card')).toBeVisible({ timeout: 30_000 });
    await expectClean(page);
  });

  test('a tool with its privacy panel open', async ({ page }) => {
    await page.goto('/resize-image/');
    await page.locator('#privacy-toggle').click();
    await expect(page.locator('#privacy-panel')).toBeVisible();
    await expectClean(page);
  });

  test('the hub with the language menu open', async ({ page }) => {
    await page.goto('/');
    await page.locator('details.lang-pick summary').first().click();
    await expect(page.locator('.lang-pick-menu a').first()).toBeVisible();
    await expectClean(page);
  });
});

/* ------------------------------------------------------------ 3. dark mode */

test.describe('axe: dark mode', () => {
  // Contrast is evaluated against the colours actually painted, and the
  // stylesheet paints a second set under prefers-color-scheme: dark. One
  // palette passing says nothing about the other.
  for (const pagePath of ['/', '/resize-image/']) {
    test(`clean in dark: ${pagePath}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto(pagePath);
      await expectClean(page);
    });
  }
});

/* --------------------------------------------------------- 4. the keyboard */

/**
 * Press Tab until the element with `id` holds focus, within a budget.
 *
 * A budget rather than a fixed count, because the number of stops before the
 * picker varies by page - the crumbs, the header buttons, the language menu.
 */
async function tabReaches(page: Page, id: string, budget = 80): Promise<boolean> {
  for (let press = 0; press < budget; press += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.id ?? '');
    if (focused === id) return true;
  }
  return false;
}

test.describe('keyboard: the file picker is reachable by Tab', () => {
  for (const slug of TOOLS.filter((tool) => hasFilePicker(tool))) {
    test(`tab reaches the picker: ${slug}`, async ({ page }) => {
      // The third-party scripts are blocked for this pass only. Ad iframes
      // insert tab stops of their own, in an order that varies run to run,
      // and the claim under test is about the page's own controls - the
      // file-picker partial's promise that the visually hidden input stays
      // focusable and reachable. A nondeterministic detour through an ad
      // frame tests the ad network, not the claim.
      await page.route(
        /googlesyndication|googletagmanager|doubleclick|google-analytics|adtrafficquality|buymeacoffee|gstatic|googleapis/,
        (route) => route.abort(),
      );

      await page.goto(`/${slug}/`);
      expect(
        await tabReaches(page, 'file-input'),
        'Tab never reached #file-input - the picker is not keyboard-reachable',
      ).toBe(true);
    });
  }
});
