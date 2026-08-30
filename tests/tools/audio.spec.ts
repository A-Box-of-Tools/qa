import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { loudThenQuiet, peakBetween, readWav } from '../../lib/wav';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the two sound tools: the editor and the
 * trimmer.
 *
 * Sound is the one medium where nothing can be checked by looking at it, and
 * where a wrong answer is least likely to be noticed at the time. A recording
 * played back at the wrong speed still plays. One that was not reversed still
 * plays. One cut a second short still plays. Every failure here is silent in
 * the literal sense.
 *
 * Both tools write WAV - as edit-audio's README says, because no browser ships
 * an encoder that could write anything else - which makes this the easiest
 * pair on the site to check exactly. lib/wav.ts builds a fixture with known
 * content and reads the result back sample by sample, with no codec in
 * between.
 *
 * The fixture is loud for its first half and quiet for its second. That
 * asymmetry is what makes "was this actually reversed" a question about
 * numbers rather than about listening.
 */

const EDITOR = '/edit-audio/';
const TRIMMER = '/trim-audio/';

const SECONDS = 3;
const SAMPLE_RATE = 44_100;

/** Put the fixture into whichever tool is open and wait for it to be read. */
async function loadSound(page: Page, path: string, name = 'recording.wav'): Promise<Buffer> {
  const bytes = loudThenQuiet(SECONDS, SAMPLE_RATE);

  await page.goto(path);
  await page.locator('#file-input').setInputFiles({
    name, mimeType: 'audio/wav', buffer: bytes,
  });

  await expect(page.locator('#source')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#src-length')).not.toHaveText('—', { timeout: 60_000 });
  return bytes;
}

/** Export with the current settings and return the WAV the browser saved. */
async function exportSound(page: Page): Promise<Buffer> {
  await expect(page.locator('#export')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#export').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 120_000 });

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the browser saved no file');
  return fs.readFileSync(path);
}

/** Move the preview's playhead and wait for it to land. */
async function seekTo(page: Page, seconds: number): Promise<void> {
  await page.evaluate((t) => new Promise<void>((resolve) => {
    const audio = document.getElementById('preview') as HTMLAudioElement;
    const done = () => { audio.removeEventListener('seeked', done); resolve(); };
    audio.addEventListener('seeked', done);
    audio.currentTime = t;
  }), seconds);
}

test.describe('the fixture itself', () => {
  test('control: it really is loud then quiet', async () => {
    // The control for the reverse test. If the fixture were symmetrical,
    // "reversed" and "not reversed" would look identical in the numbers and
    // the test would pass whatever the tool did.
    const wav = readWav(loudThenQuiet(SECONDS, SAMPLE_RATE));

    expect(wav.sampleRate).toBe(SAMPLE_RATE);
    expect(wav.channels).toBe(1);
    expect(wav.seconds).toBeCloseTo(SECONDS, 2);

    const front = peakBetween(wav, 0, 0.4);
    const back = peakBetween(wav, 0.6, 1);
    expect(front).toBeGreaterThan(0.5);
    expect(back).toBeLessThan(0.2);
  });
});

test.describe('edit-audio: changing a recording', () => {
  test('it reads the recording and reports its real length', async ({ page }) => {
    test.setTimeout(120_000);
    await loadSound(page, EDITOR);

    await expect(page.locator('#src-length')).toContainText(/0:0[23]/);
    await expect(page.locator('#src-peak')).not.toHaveText('—');
  });

  test('leaving everything alone gives the recording back', async ({ page }) => {
    // The identity case, and the control for the three below: if an untouched
    // export already came back at the wrong length or the wrong way round,
    // none of the other results would mean anything.
    test.setTimeout(180_000);
    await loadSound(page, EDITOR);

    const wav = readWav(await exportSound(page));
    expect(wav.seconds).toBeCloseTo(SECONDS, 1);

    const front = peakBetween(wav, 0, 0.4);
    const back = peakBetween(wav, 0.6, 1);
    expect(front, 'the loud half did not come back loud').toBeGreaterThan(0.5);
    expect(back, 'the quiet half did not come back quiet').toBeLessThan(0.25);
  });

  test('reversing really does turn the recording round', async ({ page }) => {
    // Checked in the samples: the loud half has to end up at the end. A tool
    // that ignored the tick would produce a file that plays perfectly well and
    // is simply not what was asked for.
    test.setTimeout(180_000);
    await loadSound(page, EDITOR);

    await page.locator('#reverse').check();
    const wav = readWav(await exportSound(page));

    expect(wav.seconds).toBeCloseTo(SECONDS, 1);

    const front = peakBetween(wav, 0, 0.4);
    const back = peakBetween(wav, 0.6, 1);
    expect(back, 'the loud half is not at the end').toBeGreaterThan(0.5);
    expect(front, 'the quiet half is not at the start').toBeLessThan(0.25);
  });

  test('doubling the speed halves the length', async ({ page }) => {
    // The speed control is logarithmic - its slider runs -2..2 - so this also
    // checks that the number in the box means what it says.
    test.setTimeout(180_000);
    await loadSound(page, EDITOR);

    await page.locator('#speed-value').fill('2');
    await page.locator('#speed-value').blur();
    await expect(page.locator('#sum-length')).not.toHaveText('—');

    const wav = readWav(await exportSound(page));
    expect(wav.seconds, 'twice the speed should be half the length')
      .toBeCloseTo(SECONDS / 2, 1);
  });

  test('halving the speed doubles the length', async ({ page }) => {
    test.setTimeout(180_000);
    await loadSound(page, EDITOR);

    await page.locator('#speed-value').fill('0.5');
    await page.locator('#speed-value').blur();

    const wav = readWav(await exportSound(page));
    expect(wav.seconds).toBeCloseTo(SECONDS * 2, 0);
  });

  test('a quiet recording can be lifted', async ({ page }) => {
    // +6 dB is a doubling of amplitude. The fixture's loud half is already at
    // 0.9, so this is measured on the quiet half, which has room to grow.
    test.setTimeout(180_000);
    await loadSound(page, EDITOR);
    const plain = readWav(await exportSound(page));
    const before = peakBetween(plain, 0.6, 1);

    await page.goto(EDITOR);
    await loadSound(page, EDITOR);
    await page.locator('#volume-value').fill('6');
    await page.locator('#volume-value').blur();

    const lifted = readWav(await exportSound(page));
    const after = peakBetween(lifted, 0.6, 1);

    expect(after, 'the volume did not go up').toBeGreaterThan(before * 1.5);
  });

  test('the bit depth asked for is the bit depth written', async ({ page }) => {
    test.setTimeout(180_000);
    await loadSound(page, EDITOR);

    await page.locator('#depth').selectOption('32');
    const wav = readWav(await exportSound(page));
    expect(wav.bitsPerSample).toBe(32);
  });
});

test.describe('trim-audio: keeping part of a recording', () => {
  test('it reads the recording and reports its real length', async ({ page }) => {
    test.setTimeout(120_000);
    await loadSound(page, TRIMMER);
    await expect(page.locator('#tl-total')).toContainText(/0:0[23]\./);
  });

  test('marking a part in and out records it, and undo takes it back', async ({ page }) => {
    test.setTimeout(120_000);
    await loadSound(page, TRIMMER);

    await seekTo(page, 0.5);
    await page.locator('#mark-in').click();
    await seekTo(page, 2.0);
    await page.locator('#mark-out').click();

    await expect(page.locator('#segment-rows tr')).toHaveCount(1, { timeout: 30_000 });

    await page.locator('#undo').click();
    await expect(page.locator('#segment-rows tr')).toHaveCount(0);
  });

  test('the trimmed file is as long as the part that was marked', async ({ page }) => {
    // Cut on the sample, which is the tool's own claim. A second either way is
    // inaudible as a fault and obvious in the numbers.
    test.setTimeout(180_000);
    await loadSound(page, TRIMMER);

    await seekTo(page, 0.5);
    await page.locator('#mark-in').click();
    await seekTo(page, 2.0);
    await page.locator('#mark-out').click();
    await expect(page.locator('#segment-rows tr')).toHaveCount(1, { timeout: 30_000 });

    const wav = readWav(await exportSound(page));
    expect(wav.seconds, 'the trimmed length is not the marked length')
      .toBeCloseTo(1.5, 1);
  });

  test('the part kept is the part that was marked, not the start of the file', async ({ page }) => {
    // Marking the last third takes the quiet half. A tool that always returned
    // the opening of the recording would give a loud file of the right length,
    // and the length alone would not notice.
    test.setTimeout(180_000);
    await loadSound(page, TRIMMER);

    await seekTo(page, 2.0);
    await page.locator('#mark-in').click();
    await seekTo(page, 2.9);
    await page.locator('#mark-out').click();
    await expect(page.locator('#segment-rows tr')).toHaveCount(1, { timeout: 30_000 });

    const wav = readWav(await exportSound(page));
    expect(peakBetween(wav, 0, 1), 'the loud opening was returned instead of the marked part')
      .toBeLessThan(0.3);
  });
});

test.describe('the sound tools: the promise', () => {
  test('the recording never leaves the page', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(EDITOR);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const bytes = await loadSound(page, EDITOR, 'private.wav');
    await exportSound(page);
    await quiet(page);

    const marker = bytes.toString('base64').slice(4000, 4080);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the recording was sent').not.toContain(marker);
    }
  });
});
