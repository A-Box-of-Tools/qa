import { test, expect, type Page } from '@playwright/test';
import { discoverTools, hasFilePicker } from '../lib/tools';
import { encodePng } from '../lib/image-fixtures';
import { buildPdf } from '../lib/pdf';
import { animationFixture } from '../lib/gif';
import { writeWav } from '../lib/wav';
import { writeDicom } from '../lib/dicom';
import { HEIC_FIXTURE } from '../lib/heic';
import fs from 'node:fs';

/**
 * Changing language in the middle of a job must not throw the job away.
 *
 * Somebody drops a photo into the resizer, sees the page is in the wrong
 * language, and switches. That used to cost them the photo: the switcher is a
 * plain link to a different URL, the page reloaded from nothing, and every
 * tool started again at its empty state.
 *
 * These tests were written while that was still true, and were marked as
 * expected failures - the specification of what the switcher should do rather
 * than a report of what it did. shared/lang-keep.js has since made them pass,
 * so the marking is gone and they are now what they look like: a guard on
 * behaviour that exists.
 *
 * WHAT THESE TESTS ASSERT, AND WHY IT IS NOT "the file input still has files"
 *
 * A browser will not let a script put a File back into an <input type=file>;
 * that restriction is the whole reason file pickers are trustworthy. So no
 * implementation could ever satisfy that assertion, and a test demanding it
 * would be demanding something impossible.
 *
 * What an implementation can restore is the state the file produced - the
 * crop controls, the tag table, the frame list, whichever panels a given tool
 * opens once it has something to work on. So each test lets the page say what
 * that means for itself: it records which elements are visible before the
 * file, again after it, and requires the ones the file brought into view to
 * be back after the language changes.
 *
 * That comparison carries its own control. If choosing a file changes nothing
 * visible, the test says so and stops, rather than going on to assert the
 * preservation of a state it never established.
 *
 * SHARE-TEXT IS EXCLUDED
 *
 * Its state is a live WebRTC connection and an open rendezvous socket, not a
 * file. A navigation ends the share by design - "closing the tab is the whole
 * of the deletion" - so preserving it across one would contradict the tool.
 *
 * Tools with no file picker are not here either: they generate rather than
 * receive, and what would be preserved is a typed box rather than a chosen
 * file, which is a different question from the one asked.
 */

const SUBJECTS = discoverTools().filter((slug) => hasFilePicker(slug) && slug !== 'share-text');

type Upload = { name: string; mimeType: string; buffer: Buffer };

const PNG = (): Upload => ({
  name: 'language-switch.png',
  mimeType: 'image/png',
  buffer: encodePng(240, 180, (x, y) => [(x * 3) % 256, (y * 5) % 256, 120] as [number, number, number]),
});

/**
 * Something the tool under test will actually accept, chosen from the accept
 * attribute its own picker declares.
 *
 * Read from the page rather than from a list kept here, for the reason
 * lib/tools.ts exists: a list would be a second copy of the site's own facts,
 * wrong the first time a tool changed what it takes. The point of the file is
 * only to get the tool into a state worth preserving - a tool handed
 * something it rejects shows an error, and "the error message survived the
 * language switch" is not the thing being asked about.
 */
function fixtureFor(slug: string, accept: string): Upload | null {
  if (slug === 'dicom-viewer') {
    return { name: 'scan.dcm', mimeType: 'application/dicom', buffer: writeDicom() };
  }
  if (slug === 'heic-to-jpg') {
    return { name: 'photo.heic', mimeType: 'image/heic', buffer: fs.readFileSync(HEIC_FIXTURE) };
  }
  if (accept.includes('application/pdf')) {
    return { name: 'doc.pdf', mimeType: 'application/pdf', buffer: buildPdf([{ label: 'Language switch test', width: 400, height: 300 }]) };
  }
  if (accept.includes('image/svg+xml')) {
    return {
      name: 'drawing.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#2b7"/></svg>', 'utf8'),
    };
  }
  if (accept.includes('image/gif') && !accept.includes('image/*')) {
    return { name: 'clip.gif', mimeType: 'image/gif', buffer: animationFixture(48, 32, 3).bytes };
  }
  if (accept.includes('audio/')) {
    // A second of quiet tone: enough for a tool to decode and open its editor.
    const samples = new Float32Array(44_100);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 20) * 0.3;
    return { name: 'sound.wav', mimeType: 'audio/wav', buffer: writeWav(samples) };
  }
  // Video tools need a real clip, which costs wall-clock to record; they are
  // covered by the same central mechanism as everything else, so they are
  // left out rather than paid for thirty times over.
  if (accept.includes('video/') && !accept.includes('image/')) return null;
  if (accept.includes('image/') || accept.includes('*/*')) return PNG();
  // The text tools take a file too, and a text file is the cheapest fixture
  // on the site.
  return { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('language switch test\n', 'utf8') };
}

/**
 * The ids of everything currently on screen inside the tool's own area.
 *
 * Scoped to #main so that ad slots, which come and go on their own schedule,
 * cannot be mistaken for the tool changing state.
 */
async function visible(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#main [id]'))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.id)
      .sort());
}

/** Follow the header switcher to another language, and wait for the new page. */
async function switchLanguage(page: Page): Promise<string> {
  await page.locator('details.lang-pick summary').first().click();
  const link = page.locator('.lang-pick-menu a').first();
  const href = (await link.getAttribute('href')) ?? '';
  // The pathname is captured before the click. Reading page.url() inside the
  // predicate reads it after navigation, so it compares the new address with
  // itself and waits for a change that has already happened.
  const from = new URL(page.url()).pathname;
  await Promise.all([
    page.waitForURL((url) => url.pathname !== from, { timeout: 30_000 }),
    link.click(),
  ]);
  await page.waitForLoadState('domcontentloaded');
  return href;
}

test.describe('switching language keeps the work', () => {
  for (const slug of SUBJECTS) {
    test(`${slug} still has the file afterwards`, async ({ page }) => {
      test.setTimeout(120_000);


      await page.goto(`/${slug}/`);

      const accept = (await page.locator('#file-input').getAttribute('accept')) ?? '';
      const fixture = fixtureFor(slug, accept);
      test.skip(fixture === null, 'needs a recorded video; the mechanism is shared and covered elsewhere');

      const empty = await visible(page);
      await page.locator('#file-input').setInputFiles(fixture!);

      // Wait for the page to react to the file at all, rather than a fixed
      // pause: what "reacted" means differs per tool, but every one of them
      // shows something it was not showing before.
      await expect
        .poll(async () => (await visible(page)).join('|'), { timeout: 45_000 })
        .not.toBe(empty.join('|'));

      const loaded = await visible(page);
      const appeared = loaded.filter((id) => !empty.includes(id));

      // An error panel is not state worth preserving. If the only thing the
      // file produced was a complaint, this tool rejected the fixture and the
      // test has nothing to say about it - better to skip loudly than to
      // assert that an error message should survive a language change.
      // Errors are not state worth preserving, and neither is a progress bar:
      // both are things the page says while something is happening, not
      // things the visitor made. split-gif was still drawing its frames when
      // the switch happened, and demanding its progress bar survive would be
      // demanding the new page still be busy with work the old one finished.
      const opened = appeared.filter((id) => !/error|invalid|fail|progress|spinner|working|busy/i.test(id));
      test.skip(
        opened.length === 0,
        `/${slug}/ did not accept the shared fixture (it showed ${appeared.join(', ') || 'nothing'})`,
      );

      await switchLanguage(page);

      // Polled rather than sampled once. Restoring the work means reading it
      // back and re-running whatever the tool does with it, which takes a
      // different length of time on every tool - a single fixed pause tests
      // whichever ones happen to be quicker than it.
      await expect
        .poll(async () => {
          const now = await visible(page);
          return opened.filter((id) => !now.includes(id)).length;
        }, { timeout: 20_000 })
        .toBe(0)
        .catch(() => { /* the precise list is reported below */ });

      const after = await visible(page);
      const lost = opened.filter((id) => !after.includes(id));
      expect(
        lost,
        `switching language threw away the work on /${slug}/: ${lost.join(', ')} `
        + 'was open before the switch and is gone after it. The file has to be chosen again.',
      ).toEqual([]);
    });
  }
});
