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
 *
 * EVERY ONE OF THEM IS BOUNDED FROM OUT HERE, AND ASKED ONCE
 *
 * See ask() below. Both halves of that were learned the expensive way and
 * both are load-bearing.
 */

/**
 * Answers this worker already has, by engine and question.
 *
 * A browser does not grow a codec halfway through a run, so asking once and
 * remembering is not an optimisation of a correct thing - it is what makes
 * these affordable at all. Before this, every test in a gated file paid the
 * probe again, inside its own thirty-second budget, on top of a navigation to
 * the live site; the camera gate alone could spend ten seconds per test
 * establishing a fact that had not changed since the first one.
 *
 * Keyed by engine as well as question, because a worker is not guaranteed to
 * stay with one project for its whole life and an answer from Chromium is not
 * an answer about WebKit.
 */
const answers = new Map<string, unknown>();

/**
 * Put a question to the page, and take silence for an answer.
 *
 * THE PART THAT MATTERS: the deadline is out here, in Node, and not inside
 * the page. The first version of these probes raced the question against a
 * `setTimeout` in the browser, which is sound reasoning about a promise that
 * never settles and useless against the thing that actually happens.
 * `VideoEncoder.isConfigSupported` on the WebKit build CI runs does not merely
 * fail to resolve - it blocks the main thread, so the timer set to rescue it
 * never gets a turn. A probe with a two-second internal deadline sat there for
 * a hundred and twenty seconds and took nineteen tests down with it, every one
 * of them a test the probe existed to skip.
 *
 * A timer in this process cannot be blocked by that page. So the bound is
 * here, the fallback is the cautious answer, and a wedged page costs one
 * deadline rather than one test timeout per test in the file.
 *
 * The abandoned evaluate is left running. There is nothing useful to do with
 * a page whose main thread is stuck, and the only caller is a skip - after
 * which Playwright discards the page anyway.
 */
export async function ask<T>(
  page: Page,
  question: string,
  work: () => Promise<T>,
  cautious: T,
  ms = 8_000,
): Promise<T> {
  const engine = page.context().browser()?.browserType().name() ?? 'unknown';
  const key = `${engine}:${question}`;
  if (answers.has(key)) return answers.get(key) as T;

  let timer: NodeJS.Timeout | undefined;
  const answer = await Promise.race([
    work().catch(() => cautious),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(cautious), ms); }),
  ]);
  clearTimeout(timer);

  answers.set(key, answer);
  return answer;
}

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
  return ask(page, 'files-in-storage', () => page.evaluate(async () => {
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
  }), false);
}

/**
 * Does this engine offer a camera interface at all?
 *
 * The narrow question, and the one the tool itself asks: `camera.available()`
 * in tools/qr-barcode-reader/src/camera.js is this same expression. When it is
 * false the reader says "This browser has no camera interface for a page to
 * ask for", which is the sentence the refusal test checks - so that test needs
 * to know exactly what the tool knows, and nothing more.
 *
 * Distinct from canFakeCamera() below, which asks whether a camera can be
 * supplied. An engine can have the interface and still be impossible to hand a
 * picture to, and the CI build is exactly that.
 */
export async function hasCameraInterface(page: Page): Promise<boolean> {
  return ask(page, 'camera-interface',
    () => page.evaluate(() => Boolean(navigator.mediaDevices?.getUserMedia)), false);
}

/**
 * Can this engine be given the fake camera the reader's tests hand it?
 *
 * Not "does it have the API", which was the first version of this and was
 * wrong in the expensive direction. Playwright's WebKit on Windows defines no
 * `navigator.mediaDevices` at all; the Linux build CI runs defines it, and
 * `canvas.captureStream` beside it, and then hands back a stream that never
 * paints - so a presence check said yes and six tests then failed on a camera
 * card that never appeared.
 *
 * So this runs the stub's own steps, in order, and answers whether they end
 * with a picture: decode a picture from a data: URL, draw it, capture the
 * canvas, put the stream in a <video>, and wait for the frame the tool waits
 * for. Every one of those is something tests/tools/qr-camera.spec.ts does,
 * which is what makes a false here mean "no fake camera is possible on this
 * engine" rather than "some API was missing".
 *
 * Bounded, and false on the way out. A probe that can hang is a probe that
 * turns a skip into a test timeout, which is the one outcome worse than the
 * failure it was meant to prevent.
 *
 * A page has to be open for this: `navigator` on `about:blank` is not the
 * navigator of a page served over https, and mediaDevices depends on the
 * difference.
 */
export async function canFakeCamera(page: Page): Promise<boolean> {
  return ask(page, 'fake-camera', () => page.evaluate(async () => {
    // A 2x2 red PNG, the smallest thing that proves the decode path works.
    const PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAAB'
      + 'ytg0kAAAAFElEQVR4nGP8z4AATAxIYBQAAgAA//8DPQEQdOJPHwAAAABJRU5ErkJggg==';

    const give = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([work, new Promise<T>((resolve) => { setTimeout(() => resolve(fallback), ms); })]);

    if (!navigator.mediaDevices?.getUserMedia) return false;

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const capture = (canvas as HTMLCanvasElement & {
      captureStream?: (fps?: number) => MediaStream;
    }).captureStream;
    if (typeof capture !== 'function') return false;

    const context = canvas.getContext('2d');
    if (!context) return false;

    try {
      const image = new Image();
      const drawn = await give(new Promise<boolean>((resolve) => {
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = PICTURE;
      }), 3_000, false);
      if (!drawn) return false;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const stream = capture.call(canvas, 30);
      if (!stream || stream.getVideoTracks().length === 0) return false;

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      // Bounded like everything else here. On an engine whose canvas stream
      // never paints, play() is a promise that may never settle, and this one
      // is inside the page - so it is raced there as well as out in Node.
      await give(video.play().catch(() => {}), 3_000, undefined);

      const painted = await give(new Promise<boolean>((resolve) => {
        const look = () => {
          if (video.videoWidth > 0) resolve(true);
          else requestAnimationFrame(look);
        };
        look();
      }), 3_000, false);

      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
      return painted;
    } catch {
      return false;
    }
  }), false);
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

/**
 * Can this engine decode a sound file?
 *
 * Three tools need it - the audio editor, the trimmer, and the extractor
 * website #297 added - and all three ask the browser rather than carrying a
 * decoder, which is the right choice and makes them exactly as capable as the
 * browser is. Playwright's WebKit on Windows has no Web Audio at all:
 * `AudioContext`, `webkitAudioContext` and `OfflineAudioContext` are every
 * one of them undefined. The Linux build CI runs has them, which is why this
 * asks instead of naming a browser - a gate written from either machine alone
 * would be wrong on the other, and that mistake has already been made twice
 * in this repository.
 *
 * Asked by decoding rather than by name: a tenth of a second of silence,
 * built here as a WAV, handed to decodeAudioData. An engine that will not
 * take that will not take anything a visitor brings either.
 */
export async function canDecodeAudio(page: Page): Promise<boolean> {
  return ask(page, 'decode-audio', () => page.evaluate(async () => {
    const Context = (globalThis as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    }).AudioContext ?? (globalThis as {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (typeof Context !== 'function') return false;

    // A tenth of a second of 16-bit PCM silence: forty-four bytes of header
    // and then the samples, which is the whole of a WAV.
    const rate = 44_100;
    const frames = Math.round(rate / 10);
    const bytes = new ArrayBuffer(44 + (frames * 2));
    const view = new DataView(bytes);
    const ascii = (at: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + (frames * 2), true);
    ascii(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, frames * 2, true);

    let context: AudioContext | null = null;
    try {
      context = new Context();
      const decoded = await Promise.race([
        context.decodeAudioData(bytes),
        new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000); }),
      ]);
      return Boolean(decoded && decoded.length > 0);
    } catch {
      return false;
    } finally {
      void context?.close();
    }
  }), false);
}
