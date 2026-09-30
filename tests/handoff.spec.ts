import { test, expect } from '@playwright/test';
import { encodePng } from '../lib/image-fixtures';
import { keepsFilesInStorage, withoutThirdParties } from '../lib/engine';

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
    await page.goto('/images-to-pdf/');

    await expect(
      page.locator(ROW),
      'the page offers to carry a result before one exists',
    ).toBeHidden();

    // Still nothing to carry with a file merely chosen: the tool has
    // something to work on, not something to hand on.
    await page.locator('#file-input').setInputFiles([40, 120].map((v, i) => ({
      name: `page-${i}.png`,
      mimeType: 'image/png',
      buffer: encodePng(120, 90, () => [v, v, v]),
    })));
    await expect(page.locator('#image-list li')).toHaveCount(2, { timeout: 30_000 });
    await expect(
      page.locator(ROW),
      'the offer appeared when files were chosen rather than when one was made',
    ).toBeHidden();
  });

  test('is offered once the tool has made something', async ({ page }) => {
    // The other half. A row that never appears would pass the test above
    // perfectly, and would have quietly removed a feature.
    // images-to-pdf rather than the stacker, which needs OffscreenCanvas and
    // therefore cannot make anything at all in WebKit - a tool that cannot
    // produce a result is no way to ask whether producing one reveals the
    // row. This one draws no canvases and works in every engine.
    test.setTimeout(240_000);
    await page.goto('/images-to-pdf/');
    await page.locator('#file-input').setInputFiles([40, 120].map((v, i) => ({
      name: `page-${i}.png`,
      mimeType: 'image/png',
      buffer: encodePng(120, 90, () => [v, v, v]),
    })));
    await expect(page.locator('#image-list li')).toHaveCount(2, { timeout: 30_000 });

    await expect(page.locator('#export')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#export').click();
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

async function makeCarriablePdf(page: import('@playwright/test').Page): Promise<number[]> {
  await withoutThirdParties(page);
  await page.goto('/images-to-pdf/');
  await page.locator('#file-input').setInputFiles([40, 120].map((shade, index) => ({
    name: `handoff-${index}.png`, mimeType: 'image/png',
    buffer: encodePng(120, 90, () => [shade, shade, shade]),
  })));
  await expect(page.locator('#image-list li')).toHaveCount(2);
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 30_000 });
  return page.locator('#download').evaluate(async (anchor) => Array.from(new Uint8Array(
    await (await fetch((anchor as HTMLAnchorElement).href)).arrayBuffer(),
  )));
}

test('handoff: images-to-pdf carries the exact PDF into merge-pdf once', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!await keepsFilesInStorage(page), 'this engine cannot preserve a File in IndexedDB');
  const original = await makeCarriablePdf(page);
  expect(original.length).toBeGreaterThan(500);
  await page.addInitScript(() => {
    // The receiver clears the picker after taking its own File snapshot.
    // Retain the actual delivered objects before that normal reset, without
    // replacing the event, the files, or any step of the receiving tool.
    const delivered: File[][] = [];
    (window as unknown as { qaDeliveredFiles: File[][] }).qaDeliveredFiles = delivered;
    document.addEventListener('change', (event) => {
      const input = event.target;
      if (input instanceof HTMLInputElement && input.id === 'file-input') {
        delivered.push(Array.from(input.files ?? []));
      }
    }, true);
  });
  await Promise.all([
    page.waitForURL('**/merge-pdf/'),
    page.locator('nav.handoff a[data-slug="merge-pdf"]').click(),
  ]);
  await expect(page.locator('#page-list li')).toHaveCount(2, { timeout: 30_000 });
  const delivered = await page.evaluate(async () => {
    const events = (window as unknown as { qaDeliveredFiles: File[][] }).qaDeliveredFiles;
    const files = events.flat();
    return { events: events.length, count: files.length, bytes: files.length === 1
      ? Array.from(new Uint8Array(await files[0].arrayBuffer())) : [] };
  });
  expect(delivered.events, 'the handoff must dispatch one delivery').toBe(1);
  expect(delivered.count).toBe(1);
  expect(delivered.bytes).toEqual(original);
  const pending = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const opening = indexedDB.open('abox-handoff', 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const transaction = db.transaction('files', 'readonly');
      const read = transaction.objectStore('files').get('merge-pdf');
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
      transaction.oncomplete = () => db.close();
    };
  }));
  expect(pending, 'the receiver left the already-delivered file pending').toBeUndefined();
  // Receiving consumes the record: a later visit must not rediscover an old
  // document as though the visitor had just chosen it again.
  await page.reload();
  await expect(page.locator('#page-list li')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { qaDeliveredFiles: File[][] }).qaDeliveredFiles.length))
    .toBe(0);
});

test('handoff: refused storage still opens the destination with no partial delivery', async ({ page }) => {
  test.setTimeout(120_000);
  await makeCarriablePdf(page);
  await page.evaluate(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', {
      configurable: true,
      value() { throw new DOMException('Storage refused by this test', 'SecurityError'); },
    });
  });
  await Promise.all([
    page.waitForURL('**/merge-pdf/'),
    page.locator('nav.handoff a[data-slug="merge-pdf"]').click(),
  ]);
  await expect(page.locator('#dropzone')).toBeVisible();
  await expect(page.locator('#page-list li')).toHaveCount(0);
  await expect(page.locator('#load-error')).toBeHidden();
});
