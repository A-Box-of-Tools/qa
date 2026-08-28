import { test, expect } from '@playwright/test';
import { encodePng } from '../lib/image-fixtures';

/**
 * The carry-on row, and when a tool is allowed to offer it.
 *
 * Twelve tools end with a strip that hands a finished file straight to the
 * next tool, without a download and a re-upload. It used to be rendered
 * `inert` rather than hidden, on the argument that the row says where this
 * tool leads and that is worth reading early.
 *
 * What that produced on a page where nothing had been made yet was an offer
 * to carry a result that did not exist: a bordered box under a greyed-out
 * button, itself greyed, promising to pass on a file the page had not
 * produced. Website #236 hid it until there is something to carry.
 *
 * That is a promise about a control appearing at the right moment, and the
 * two halves fail differently. Showing it too early is what #236 fixed.
 * Never showing it at all would be the fix going too far, and would look
 * exactly like success to a test that only checked the first half - so both
 * are here, in one journey, on a tool that really does produce a file.
 */

const ROW = 'nav.handoff';

test.describe('the carry-on row', () => {
  test('is not offered before there is anything to carry', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/stack-images/');

    await expect(
      page.locator(ROW),
      'the page offers to carry a result before one exists',
    ).toBeHidden();

    // Still nothing to carry with a file merely chosen: the tool has
    // something to work on, not something to hand on.
    await page.locator('#file-input').setInputFiles([40, 120, 200].map((v, i) => ({
      name: `frame-${i}.png`,
      mimeType: 'image/png',
      buffer: encodePng(64, 48, () => [v, v, v]),
    })));
    await expect(page.locator('#frame-list li')).toHaveCount(3, { timeout: 30_000 });
    await expect(
      page.locator(ROW),
      'the offer appeared when files were chosen rather than when one was made',
    ).toBeHidden();
  });

  test('is offered once the tool has made something', async ({ page }) => {
    // The other half. A row that never appears would pass the test above
    // perfectly, and would have quietly removed a feature.
    test.setTimeout(240_000);
    await page.goto('/stack-images/');
    await page.locator('#file-input').setInputFiles([40, 120, 200].map((v, i) => ({
      name: `frame-${i}.png`,
      mimeType: 'image/png',
      buffer: encodePng(64, 48, () => [v, v, v]),
    })));
    await expect(page.locator('#frame-list li')).toHaveCount(3, { timeout: 30_000 });

    await page.locator('#align').selectOption('none');
    await expect(page.locator('#run')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#run').click();
    await expect(page.locator('#result')).toBeVisible({ timeout: 120_000 });

    await expect(
      page.locator(ROW),
      'the tool made a file and did not offer to carry it anywhere',
    ).toBeVisible({ timeout: 30_000 });

    // And it offers somewhere real: a row with no targets in it is a heading
    // with nothing under it.
    await expect(page.locator(`${ROW} a`).first()).toBeVisible();
  });

  test('every tool that declares targets keeps them to itself until then',
    async ({ page }) => {
      // The rule across all twelve, cheaply: none of them may show the row at
      // rest. Producing a result on each would mean twelve encodes to learn
      // what the journey above already establishes about the mechanism, which
      // is shared.
      test.setTimeout(240_000);
      const offenders: string[] = [];

      for (const slug of ['resize-image', 'compress-image', 'crop-video', 'redact-image',
        'heic-to-jpg', 'image-to-ico', 'svg-to-image', 'document-scanner']) {
        await page.goto(`/${slug}/`);
        const row = page.locator(ROW);
        if (await row.count() === 0) continue; // this tool declares no targets
        if (await row.isVisible().catch(() => false)) offenders.push(slug);
      }

      expect(
        offenders,
        `these offer to carry a result before making one: ${offenders.join(', ')}`,
      ).toEqual([]);
    });
});
