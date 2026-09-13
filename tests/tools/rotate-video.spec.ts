import { test, expect, type Page } from '@playwright/test';
import { canEncodeAac, canEncodeVideo, recordVideo } from '../../lib/browser-video';
import { audioTrack, isMp4, readMp4, videoTrack, type Mp4Track } from '../../lib/mp4';
import { loadFile, loadTheExample, pressChip, runAndSave } from '../../lib/tool-frame';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the video rotator.
 *
 * WHAT THE TOOL PROMISES
 *
 * That a sideways clip comes out the right way up "and not one frame is
 * decoded to do it": the turn goes into the track's display matrix and every
 * frame is copied across as it was. Baking the turn in - drawing every frame
 * turned and encoding again - is the other path, for the players that ignore
 * the matrix.
 *
 * WHAT IS CHECKED, AND WITH WHAT
 *
 * The page ends a run by re-opening its own output and reporting the
 * rotation it read back; that is the tool marking its own work. So the file
 * is opened here with lib/mp4.ts, which reads the nine numbers of tkhd's
 * matrix and says which of the four turns they are. The copy path has to
 * leave the stored frame size alone (a phone writes it that way, and Chrome
 * stretches a picture whose header says the turned size as well) and hand
 * back exactly the samples it was given, which is the checkable meaning of
 * "not one frame decoded". The bake path has to do the opposite: no matrix
 * at all and the frames themselves the turned size.
 *
 * WHICH CLIP
 *
 * A clip the browser under test recorded (lib/browser-video.ts): H.264, no
 * sound, and its sample count known before it goes in. Not the page's own
 * example, because that is built with AudioEncoder as AAC and Chromium on
 * the Linux runners has no AAC encoder, so the example does not exist there.
 * The example is used where it can be, for the one thing the recording
 * cannot show - that an AAC sound track is copied across, or left out when
 * asked - and that test asks canEncodeAac first.
 */

const URL_PATH = '/rotate-video/';

const SHIPPED = discoverTools().includes('rotate-video');
const NOT_YET = 'this site does not ship rotate-video yet';

const WIDTH = 320;
const HEIGHT = 240;
const SECONDS = 4;

/** Record a clip on the open page, hand it in, and say what went in. */
async function loadARecording(page: Page): Promise<Mp4Track> {
  const { bytes } = await recordVideo(page, { width: WIDTH, height: HEIGHT, seconds: SECONDS, fps: 20 });
  const before = videoTrack(readMp4(bytes));
  expect(before, 'the recording has no video track').not.toBeNull();
  expect(before!.samples, 'the recording has no samples to count').toBeGreaterThan(0);
  await loadFile(page, { name: 'sideways.mp4', mimeType: 'video/mp4', buffer: bytes });
  return before!;
}

test.describe('rotate-video: a clip the browser recorded', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page),
      'this engine can record no video, so there is nothing to turn');
    await page.goto(URL_PATH);
  });

  test('a quarter turn right goes into the matrix, and every frame is copied as it was', async ({ page }) => {
    test.setTimeout(240_000);
    const before = await loadARecording(page);

    // The first chip is pressed by default; the page's own line says what
    // the turn will do before anything runs.
    await expect(page.locator('.chip[data-turn="90"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#preview-line')).toContainText(/turned right|on its side/i);
    await expect(page.locator('#sound-note')).toContainText(/no sound/i);

    const bytes = await runAndSave(page);
    expect(isMp4(bytes), 'the rotated file is not an MP4').toBe(true);

    const file = readMp4(bytes);
    const video = videoTrack(file);
    expect(video, 'the rotated file has no video track').not.toBeNull();

    // The turn is in the matrix, and only there: the stored frame keeps its
    // size, which is what "the frames were copied" looks like in the header.
    expect(video!.rotation, 'the display matrix is not a quarter turn right').toBe(90);
    expect(video!.width, 'the stored frame width changed on the copy path').toBe(WIDTH);
    expect(video!.height, 'the stored frame height changed on the copy path').toBe(HEIGHT);

    // And in the samples: exactly the ones that went in, still H.264.
    expect(video!.samples, 'the copy does not have the frames it was given').toBe(before.samples);
    expect(video!.codec, 'the copied picture is not the H.264 it was').toBe('avc1');
    expect(file.fragmented, 'the copy is still a fragmented file').toBe(false);
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.8);
    expect(file.seconds).toBeLessThan(SECONDS + 0.8);
    expect(audioTrack(file), 'a silent clip came back with a sound track').toBeNull();
  });

  test('upside down is the other matrix', async ({ page }) => {
    test.setTimeout(240_000);
    const before = await loadARecording(page);
    await pressChip(page, '[data-turn="180"]');
    await expect(page.locator('#preview-line')).toContainText(/upside down/i);

    const video = videoTrack(readMp4(await runAndSave(page)));
    expect(video).not.toBeNull();
    expect(video!.rotation, 'the display matrix is not an upside-down turn').toBe(180);
    expect(video!.width).toBe(WIDTH);
    expect(video!.height).toBe(HEIGHT);
    expect(video!.samples).toBe(before.samples);
  });

  test('baking the turn in writes turned frames and no matrix', async ({ page }) => {
    // The other path, and the opposite evidence: the frames themselves are
    // the turned size, and the header says nothing about turning.
    test.setTimeout(300_000);
    await loadARecording(page);
    await page.locator('#bake').check();
    await expect(page.locator('#preview-line')).toContainText(/turned right|on its side/i);

    const file = readMp4(await runAndSave(page, { timeout: 240_000 }));
    const video = videoTrack(file);
    expect(video).not.toBeNull();

    expect(video!.rotation, 'a baked clip still carries a rotation in its matrix').toBe(0);
    expect(video!.width, 'the baked frame is not the turned width').toBe(HEIGHT);
    expect(video!.height, 'the baked frame is not the turned height').toBe(WIDTH);
    expect(video!.codec).toBe('avc1');
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.8);
    expect(file.seconds).toBeLessThan(SECONDS + 0.8);
  });
});

test.describe('rotate-video: the clip it ships with, which has sound', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page), 'this engine can write no video');
    test.skip(!await canEncodeAac(page),
      'this engine has no AAC encoder, so the example clip - which is built with one - cannot exist here');
    await page.goto(URL_PATH);
    await loadTheExample(page);
  });

  test('the AAC sound is copied across with the turn, and left out when asked', async ({ page }) => {
    test.setTimeout(300_000);
    await expect(page.locator('#sound-note')).toContainText(/AAC/);

    const file = readMp4(await runAndSave(page));
    expect(videoTrack(file)?.rotation).toBe(90);
    const sound = audioTrack(file);
    expect(sound, 'the sound track was lost on the copy path').not.toBeNull();
    expect(sound!.codec).toBe('mp4a');

    await page.locator('#drop-audio').check();
    const again = readMp4(await runAndSave(page));
    expect(audioTrack(again), 'the sound track is still there').toBeNull();
    expect(videoTrack(again)?.rotation).toBe(90);
  });
});

test.describe('rotate-video: what it refuses', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('something that is not a video is refused, and said so', async ({ page }) => {
    await page.goto(URL_PATH);
    await page.locator('#file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a video at all\n', 'utf8'),
    });
    await expect(page.locator('#load-error')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#run-card'), 'the last card woke for a file that was refused')
      .toHaveAttribute('inert', '');
  });
});
