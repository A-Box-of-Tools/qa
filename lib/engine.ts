import type { Page } from '@playwright/test';

/**
 * What the engine under test can actually do, asked rather than assumed.
 *
 * Four projects run this suite and they are not four skins on one browser.
 * Playwright's WebKit is missing whole APIs that Safari itself has had for
 * years - and, more awkwardly, its Linux build and its Windows build are
 * missing different ones. A test that hard-codes "skip on WebKit" is wrong on
 * one of those two the day it is written, and a test that hard-codes nothing
 * reports the engine's gaps as the site's bugs, which is worse: it is a
 * hundred failures a week that nobody reads.
 *
 * So each of these asks the page a question it can answer for itself. A
 * feature that arrives in a later build turns the skip back into a test with
 * no edit here, and a feature that never arrives says so in the skip message
 * rather than in a stack trace.
 *
 * WHAT DOES NOT BELONG HERE
 *
 * Anything the site is responsible for. These probe the browser with the
 * browser's own objects - a File, a canvas, an IndexedDB store - and touch no
 * page of the site at all, so a tool that broke can never make one of them
 * return false and quietly take its own test out of the run.
 */

/**
 * Can this engine keep a File in IndexedDB?
 *
 * Real Safari can, and shared/lang-keep.js relies on it: it is the only
 * storage a File survives, which is what lets a language switch carry the
 * chosen file across a navigation. Playwright's WebKit refuses -
 *
 *   UnknownError: Error preparing Blob/File data to be stored in object store
 *
 * - because a blob in IndexedDB is written to a file beside the database and
 * this build has nowhere to put it. Nothing about the site is involved: the
 * probe below stores a five-byte File in a database of its own.
 *
 * Worth knowing that a real browser can refuse too. Safari in private
 * browsing does exactly this, so a skip here is not only an artefact of the
 * test build - it is a state some visitors are in.
 */
export async function keepsFilesInStorage(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const NAME = 'abox-qa-storage-probe';
    try {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('probe');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('open refused'));
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('probe', 'readwrite');
          tx.objectStore('probe').put(new File(['abox'], 'probe.txt'), 'k');
          tx.oncomplete = () => resolve(null);
          tx.onerror = () => reject(new Error('write refused'));
          tx.onabort = () => reject(new Error('write aborted'));
        });
      } finally {
        db.close();
        indexedDB.deleteDatabase(NAME);
      }
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Can this engine be handed a camera at all?
 *
 * Both halves are needed and for different reasons. `navigator.mediaDevices`
 * is what the tool asks for, and Playwright's WebKit does not define it -
 * which means the camera path cannot even be reached there, and also that a
 * stub cannot be installed, since there is no object to put one on.
 * `canvas.captureStream` is how this suite supplies a picture to that stub;
 * without it there is nothing to hand back.
 *
 * A page has to be open for this: `navigator` on `about:blank` is not the
 * navigator of a page served over https, and mediaDevices is one of the
 * things that depends on the difference.
 */
export async function hasCameraApi(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    return Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof (canvas as HTMLCanvasElement & {
        captureStream?: () => MediaStream;
      }).captureStream === 'function';
  });
}

/**
 * Wait until the page has stopped talking to the network, or give up.
 *
 * A replacement for `waitForLoadState('networkidle')`, which the tests that
 * assert "nothing about this file left the page" all used and which
 * Playwright's own documentation asks people not to: it waits for five
 * hundred milliseconds with no more than two connections open, and a page
 * carrying an ad slot or a long-poll never has such a moment. When it does
 * not arrive, the test fails on a timeout that says nothing about traffic.
 *
 * This is the question those tests actually meant: has anything been
 * requested lately? A quiet stretch is the answer; running out of patience is
 * also an answer, because by then the request they were watching for would
 * have happened. Neither throws - the assertion that matters is the one on
 * the traffic they collected, and it is a better failure than a timeout.
 */
export async function quiet(
  page: Page,
  { idle = 1_500, cap = 15_000 }: { idle?: number; cap?: number } = {},
): Promise<void> {
  let last = Date.now();
  const seen = () => { last = Date.now(); };
  page.on('request', seen);
  try {
    const until = Date.now() + cap;
    while (Date.now() < until && Date.now() - last < idle) {
      await page.waitForTimeout(100);
    }
  } finally {
    page.off('request', seen);
  }
}
