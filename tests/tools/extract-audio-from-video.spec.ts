import { test, expect, type Page } from '@playwright/test';
import { canDecodeAudio, quiet } from '../../lib/engine';
import { recordVideo } from '../../lib/browser-video';
import { peakBetween, readWav, writeWav } from '../../lib/wav';

/**
 * Tool-level functional tests for the audio extractor, added by website #297.
 *
 * The tool's own README makes the claim these tests are for: there is one
 * decoder here and it is the browser's, so "the audio out of a video" is the
 * same job as "the audio out of an MP3" - the video track is simply never
 * asked for. That is a claim about what comes out, and what comes out is a
 * WAV, which is forty-four bytes of header and then the samples. Node can
 * read it, so every assertion below is made against the samples rather than
 * against what the page says it did.
 *
 * TWO FIXTURES, FOR TWO DIFFERENT REASONS
 *
 * A WAV of a known tone is the one that always runs. It exercises the whole
 * path - decode, channel choice, write - with nothing in it that depends on
 * the engine having a video codec, so a failure is about the tool.
 *
 * A recorded clip with a soundtrack is the headline case and the one the page
 * is named for, so it is here too, gated: an engine that cannot decode the
 * clip is not one this tool could have got anything out of either. The
 * soundtrack matters. A silent clip would be refused, correctly, and would
 * prove nothing about finding an audio track.
 */

const URL_PATH = '/extract-audio-from-video/';

/**
 * A second and a half of tone, in as many channels as asked for.
 *
 * The left channel carries it and the right is silent, deliberately. That one
 * asymmetry turns "did the mix-down average the channels" into a number:
 * averaging halves the peak, dropping the silent channel leaves it alone, and
 * dropping the loud one leaves nothing. lib/wav.ts reads channel zero, which
 * is the channel this is arranged around.
 */
function tone(channels: number, seconds = 1.5, rate = 44_100): Buffer {
  const frames = Math.round(seconds * rate);
  const samples = new Float32Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame * channels] = Math.sin((2 * Math.PI * 440 * frame) / rate) * 0.4;
  }
  return writeWav(samples, rate, channels);
}

/** Hand the tool a file and wait for it to have read it. */
async function load(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#source')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#result')).toBeVisible({ timeout: 60_000 });
}

/**
 * The file the download link points at, read back as a WAV.
 *
 * Fetched from the page rather than clicked, because the assertion is about
 * the bytes behind the link - a page whose Download offers something other
 * than what it just showed is the failure worth catching.
 */
async function saved(page: Page): Promise<ReturnType<typeof readWav>> {
  const base64 = await page.evaluate(async () => {
    const link = document.getElementById('download') as HTMLAnchorElement;
    const blob = await (await fetch(link.href)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary);
  });
  return readWav(Buffer.from(base64, 'base64'));
}

test.describe('extract-audio-from-video: the sound that comes out', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    // There is one decoder on this page and it is the browser's. An engine
    // with no Web Audio cannot read a sound file of any kind, so there is
    // nothing here for the tool to get right or wrong - what it says instead
    // is the subject of the last describe in this file.
    test.skip(!await canDecodeAudio(page),
      'this engine has no Web Audio, so no sound file can be read here at all');
  });

  test('the samples that come back are the samples that went in', async ({ page }) => {
    await load(page, { name: 'tone.wav', mimeType: 'audio/wav', buffer: tone(1) });

    const wav = await saved(page);
    expect(wav.channels, 'a mono file came back with a different channel count').toBe(1);
    expect(wav.sampleRate).toBe(44_100);
    // Decoding never lands exactly, so a tolerance rather than an equality -
    // but a tenth of a second is far tighter than the failure this is looking
    // for, which is a file cut short or padded out.
    expect(Math.abs(wav.seconds - 1.5), `came back ${wav.seconds.toFixed(3)}s long`)
      .toBeLessThan(0.1);

    // Not silence. Everything above would pass on a file of zeroes.
    expect(peakBetween(wav), 'the extracted audio is silent').toBeGreaterThan(0.2);
  });

  test('a stereo file keeps both channels when it is left alone', async ({ page }) => {
    await load(page, { name: 'stereo.wav', mimeType: 'audio/wav', buffer: tone(2) });

    const wav = await saved(page);
    expect(wav.channels, 'both channels were asked for and one came back').toBe(2);
    // The loud channel is still the loud one, at the level it went in at.
    expect(peakBetween(wav)).toBeGreaterThan(0.3);
  });

  test('mixing down to mono averages the channels rather than dropping one',
    async ({ page }) => {
      await load(page, { name: 'stereo.wav', mimeType: 'audio/wav', buffer: tone(2) });
      const stereo = await saved(page);

      await page.locator('#channels').selectOption('mono');
      await expect
        .poll(async () => (await saved(page)).channels, { timeout: 30_000 })
        .toBe(1);

      const mono = await saved(page);
      expect(Math.abs(mono.seconds - stereo.seconds)).toBeLessThan(0.05);
      expect(mono.frames).toBe(stereo.frames);

      // The arithmetic, and the reason the fixture is loud on one side and
      // silent on the other: averaging halves the peak. A mix-down that threw
      // the silent channel away would come back at full level, and one that
      // threw the loud channel away would come back at nothing - so this one
      // number tells all three apart.
      const loud = peakBetween(stereo);
      const mixed = peakBetween(mono);
      expect(mixed, 'the mix-down is silent - was the loud channel dropped?')
        .toBeGreaterThan(loud * 0.3);
      expect(mixed, 'the mix-down kept full level - was a channel dropped rather '
        + 'than averaged?').toBeLessThan(loud * 0.75);
    });

  test('an empty file is refused, and says so', async ({ page }) => {
    // The control on all of the above. A tool that produced a result from
    // anything would pass every test in this file.
    await page.locator('#file-input').setInputFiles({
      name: 'nothing.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(0),
    });

    await expect(
      page.locator('#error'),
      'a file with nothing in it produced no complaint',
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#result')).toBeHidden();
  });
});

test.describe('extract-audio-from-video: the job it is named for', () => {
  test('a clip with a soundtrack gives up its soundtrack', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(URL_PATH);
    test.skip(!await canDecodeAudio(page),
      'this engine has no Web Audio, so no sound file can be read here at all');

    // Recorded with sound - see lib/browser-video.ts. A silent clip would be
    // refused for the right reason and would say nothing about this job.
    const clip = await recordVideo(page, { seconds: 2, withSound: true });

    await page.locator('#file-input').setInputFiles({
      name: 'clip.mp4', mimeType: clip.mimeType, buffer: clip.bytes,
    });

    // An engine that cannot decode this clip could not have got the audio out
    // of it either, so there is nothing here for the tool to be wrong about.
    // Asked by watching which way the page went rather than by naming a
    // browser: it either reads the file or says it cannot.
    //
    // Polled rather than `locator('#result, #error').first()`, which reads as
    // "either of these" and means "whichever is first in the document" - and
    // that is #error, sitting hidden at the top of the page while the result
    // it was meant to be an alternative to appeared below it.
    await expect
      .poll(async () => (await page.locator('#result').isVisible())
        || (await page.locator('#error').isVisible()), { timeout: 120_000 })
      .toBe(true);
    test.skip(
      await page.locator('#error').isVisible(),
      'this engine will not decode the recorded clip, so there is no audio '
      + 'in it for the tool to find',
    );

    await expect(page.locator('#src-length')).not.toHaveText('—');

    const wav = await saved(page);
    expect(Math.abs(wav.seconds - 2), `the sound is ${wav.seconds.toFixed(2)}s long`)
      .toBeLessThan(0.6);
    expect(peakBetween(wav), 'the extracted track is silent').toBeGreaterThan(0.02);
  });
});

test.describe('extract-audio-from-video: the promise', () => {
  test('the film never leaves the page', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    test.skip(!await canDecodeAudio(page),
      'this engine has no Web Audio, so no sound file can be read here at all');

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const buffer = tone(1);
    await load(page, { name: 'private.wav', mimeType: 'audio/wav', buffer });
    await quiet(page);

    const marker = buffer.toString('base64').slice(200, 280);
    for (const entry of traffic) {
      expect(entry, 'the recording was sent somewhere').not.toContain(marker);
    }
  });
});

/**
 * What the page says on a browser that cannot read sound at all.
 *
 * The mirror of the skips above, and the only part of this tool such an
 * engine can be asked about. It matters because the alternative is silence:
 * a file chosen, a spinner, and a page that never finishes - which is
 * indistinguishable from a tool that is broken, and is what a visitor on an
 * older browser would be looking at.
 *
 * Playwright's WebKit on Windows is the engine this runs on today. Not a
 * statement about Safari, which has had Web Audio for over a decade; if a
 * later build gains it, this test steps aside and the ones above start.
 */
test.describe('extract-audio-from-video: with no way to read sound', () => {
  test('says so, rather than spinning', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(URL_PATH);
    test.skip(await canDecodeAudio(page),
      'this engine reads sound; the tests above cover it');

    await page.locator('#file-input').setInputFiles({
      name: 'tone.wav', mimeType: 'audio/wav', buffer: tone(1),
    });

    const said = page.locator('#error');
    await expect(
      said,
      'a browser that cannot read sound was told nothing at all',
    ).toBeVisible({ timeout: 60_000 });

    // Named as a possibility rather than as a certainty, which is the honest
    // shape: the page cannot tell "no audio track" from "this browser will
    // not read this", and its sentence says both.
    await expect(said).toContainText(/browser|audio track/i);
    await expect(said).not.toContainText('audio.');
    await expect(page.locator('#result')).toBeHidden();
  });
});
