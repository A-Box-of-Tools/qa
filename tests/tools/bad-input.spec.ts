import { test, expect, type Page } from '@playwright/test';
import { encodePng } from '../../lib/image-fixtures';
import { buildPdf } from '../../lib/pdf';
import { animationFixture } from '../../lib/gif';
import { loudThenQuiet } from '../../lib/wav';
import { writeDicom } from '../../lib/dicom';
import { heicBytes } from '../../lib/heic';

/**
 * What every tool does when the file is not what it says it is.
 *
 * Nearly every fixture in this suite is well formed, which means nearly every
 * test says what a tool does when it is given exactly what it wants. That
 * leaves the more interesting half untested: a truncated download, a file
 * renamed to the wrong extension, a PDF that is really a photograph. These
 * arrive constantly in a tool that takes whatever somebody drops on it.
 *
 * Three things are asserted, and they are chosen to be true of every tool
 * regardless of what it does:
 *
 *   1. It says so. A page that quietly does nothing is indistinguishable from
 *      a page that is still working, and the reader waits.
 *   2. It does not throw. An unhandled exception leaves the page in a state
 *      nobody designed, usually with the controls still live.
 *   3. It does not hand back a finished file made out of nonsense. This is the
 *      one that matters: a converter that emits a valid-looking file from
 *      garbage is worse than one that refuses, because nothing downstream will
 *      question it.
 *
 * What is deliberately not asserted is *which* message appears. Whether a tool
 * calls it "not a PDF" or "this file could not be read" is its business; that
 * it says something a reader can act on is not.
 */

interface Subject {
  slug: string;
  /** A file this tool would normally accept. */
  good: () => Buffer;
  mime: string;
  name: string;
  /** Where this tool puts the reason it said no. */
  errors: string;
  /** What appears only once the tool has produced something. */
  output?: string;
  /**
   * A bug this tool is known to have, as a reason. Marks the case expected to
   * fail, so the suite stays honest about it: it goes red the day the bug is
   * fixed and the expectation needs removing, rather than staying quietly red
   * for ever or being deleted and forgotten.
   */
  knownSilent?: string;
}

const SUBJECTS: Subject[] = [
  {
    slug: 'resize-image',
    good: () => encodePng(80, 60, () => [200, 40, 40]),
    mime: 'image/png',
    name: 'picture.png',
    errors: '#load-error',
    output: '#results',
  },
  {
    slug: 'image-to-ico',
    good: () => encodePng(64, 64, () => [40, 120, 200]),
    mime: 'image/png',
    name: 'logo.png',
    errors: '#load-error',
    output: '#results',
  },
  {
    slug: 'image-to-data-uri',
    good: () => encodePng(40, 40, () => [10, 200, 90]),
    mime: 'image/png',
    name: 'icon.png',
    errors: '#load-error',
    output: '#results',
  },
  {
    slug: 'merge-pdf',
    good: () => buildPdf([{ label: 'one', width: 200, height: 100 }]),
    mime: 'application/pdf',
    name: 'document.pdf',
    errors: '#load-error',
    output: '#result',
  },
  {
    slug: 'compress-pdf',
    good: () => buildPdf([{ label: 'one', width: 200, height: 100 }]),
    mime: 'application/pdf',
    name: 'document.pdf',
    errors: '#load-error',
    output: '#result',
  },
  {
    slug: 'redact-pdf',
    good: () => buildPdf([{ label: 'secret one', width: 200, height: 100 }]),
    mime: 'application/pdf',
    name: 'filing.pdf',
    errors: '#load-error',
    output: '#result',
  },
  {
    slug: 'split-gif',
    good: () => animationFixture(48, 32, 3, 100).bytes,
    mime: 'image/gif',
    name: 'animation.gif',
    errors: '#error',
    output: '#frames-card',
  },
  {
    slug: 'gif-analyzer',
    good: () => animationFixture(48, 32, 3, 100).bytes,
    mime: 'image/gif',
    name: 'animation.gif',
    errors: '#load-error',
    output: '#summary-card',
  },
  {
    slug: 'edit-audio',
    good: () => loudThenQuiet(1),
    mime: 'audio/wav',
    name: 'sound.wav',
    // This one calls it #error, not #load-error.
    errors: '#error',
    output: '#result',
    knownSilent: 'edit-audio writes the reason into #error and unhides it, but '
      + '#error sits inside <section id="export-card" hidden>, which is only '
      + 'revealed once a file has loaded successfully. So a file it cannot '
      + 'decode produces a message nobody can see, and the page appears to do '
      + 'nothing at all.',
  },
  {
    slug: 'dicom-viewer',
    good: () => writeDicom(),
    mime: 'application/dicom',
    name: 'scan.dcm',
    errors: '#load-error',
    output: '#identity-card',
  },
  {
    slug: 'heic-to-jpg',
    good: () => heicBytes(),
    mime: 'image/heic',
    name: 'photo.heic',
    errors: '#load-error',
    output: '#results',
  },
];

/** Bytes that are not any format, wearing the right name. */
function notAFileAtAll(size = 4096): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 37 + 11) & 0xff;
  return out;
}

/** A real file with its end cut off, the shape an interrupted download takes. */
const truncated = (bytes: Buffer): Buffer => bytes.subarray(0, Math.floor(bytes.length * 0.35));

/**
 * Hand a tool a file and watch what happens.
 *
 * Returns what the page did rather than asserting inside, so each case can say
 * what it expects in its own terms.
 */
async function offer(page: Page, subject: Subject, bytes: Buffer): Promise<{
  crashed: string[];
  said: string;
  produced: boolean;
}> {
  const crashed: string[] = [];
  page.on('pageerror', (error) => crashed.push(String(error)));

  await page.goto(`/${subject.slug}/`);
  await page.locator('#file-input').setInputFiles({
    name: subject.name, mimeType: subject.mime, buffer: bytes,
  });

  // There is no single event to wait for when the answer may be "nothing
  // happened" - but there is no need to wait the full window when something
  // does happen. Most files are answered within a second, one way or the
  // other; the fixed 3.5-second sleep this used to be spent four minutes a
  // run mostly waiting behind questions that were already answered. The full
  // window is only served when the page really does stay silent, which is
  // itself the finding.
  const spoke = page.locator(subject.errors).waitFor({ state: 'visible', timeout: 3500 })
    .then(() => true, () => false);
  const produced_ = subject.output
    ? page.locator(subject.output).waitFor({ state: 'visible', timeout: 3500 })
      .then(() => true, () => false)
    : new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 3500); });
  await Promise.race([spoke, produced_]);
  // A beat for the message text to finish arriving after the element shows.
  await page.waitForTimeout(250);

  const said = ((await page.locator(subject.errors).textContent()) ?? '').trim();
  const visible = await page.locator(subject.errors).isVisible().catch(() => false);

  const produced = subject.output
    ? await page.locator(subject.output).isVisible().catch(() => false)
    : false;

  return { crashed, said: visible ? said : '', produced };
}

for (const subject of SUBJECTS) {
  test.describe(`bad input: ${subject.slug}`, () => {
    test('control: the good file is accepted', async ({ page }) => {
      // Without this, "it refused the broken one" would pass for a tool that
      // refuses everything, including the file it is for.
      test.setTimeout(120_000);
      const result = await offer(page, subject, subject.good());

      expect(result.said, `the tool rejected a file it should accept: ${result.said}`).toBe('');
      expect(result.crashed, result.crashed.join('\n')).toEqual([]);
    });

    test('bytes that are not that format are refused, out loud', async ({ page }) => {
      test.setTimeout(120_000);
      if (subject.knownSilent) test.fail(true, subject.knownSilent);
      const result = await offer(page, subject, notAFileAtAll());

      expect(result.said, 'nothing on the page says the file could not be read')
        .not.toBe('');
      expect(result.crashed, `it threw instead: ${result.crashed.join('\n')}`).toEqual([]);
      expect(result.produced, 'it produced a result from bytes that are not a file')
        .toBe(false);
    });

    test('a file cut short does not crash the page', async ({ page }) => {
      // A truncated file is the interesting middle case: the beginning is
      // real, so a reader gets some way in before it runs out.
      //
      // Only the crash is asserted, deliberately. Salvaging what is there is
      // the right answer for several of these, and demanding a refusal was
      // very nearly written in as a fault: gif-analyzer reading a damaged GIF
      // and reporting what it found is the entire job of a diagnostic tool,
      // and image-to-data-uri faithfully encodes whatever bytes it was handed
      // because it never decodes the picture at all. The test would have been
      // insisting they get it wrong.
      test.setTimeout(120_000);
      const result = await offer(page, subject, truncated(subject.good()));

      expect(result.crashed, `a truncated file threw: ${result.crashed.join('\n')}`)
        .toEqual([]);


    });
  });
}

test.describe('bad input: an empty file', () => {
  test('nothing at all is refused rather than accepted', async ({ page }) => {
    // Zero bytes is the case a drag-and-drop of a still-syncing cloud file
    // produces, and the one most likely to be handled by a length check that
    // was never written.
    test.setTimeout(120_000);
    const subject = SUBJECTS[0];
    const result = await offer(page, subject, Buffer.alloc(0));

    expect(result.crashed, `an empty file threw: ${result.crashed.join('\n')}`).toEqual([]);
    expect(result.produced, 'it produced a result from an empty file').toBe(false);
  });
});
