import { test, expect } from '@playwright/test';
import { canEncodeVideo } from '../../lib/browser-video';
import { audioTrack, isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { loadTheExample, pressChip, runAndSave } from '../../lib/tool-frame';
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
 * is opened here with lib/mp4.ts, which now reads the nine numbers of tkhd's
 * matrix and says which of the four turns they are. The copy path has to
 * leave the stored frame size alone (a phone writes it that way, and Chrome
 * stretches a picture whose header says the turned size as well) and the
 * sample count unchanged, which is the checkable meaning of "not one frame
 * decoded". The bake path has to do the opposite: no matrix at all and the
 * frames themselves the turned size. Both are asserted against the example
 * the page ships, which is 960 x 540 with an AAC sound track.
 *
 * Everything here needs an engine that can encode video, because the example
 * is built in the page with VideoEncoder and AudioEncoder; the gate is the
 * same one the other video specs use, asked before any page is loaded.
 */

const URL_PATH = '/rotate-video/';

const SHIPPED = discoverTools().includes('rotate-video');
const NOT_YET = 'this site does not ship rotate-video yet';

/** The example clip's stored frame and length. */
const WIDTH = 960;
const HEIGHT = 540;
const SECONDS = 6;

test.describe('rotate-video: the clip it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page),
      'this engine can write no video, so the example cannot be built and there is nothing to turn');
    await page.goto(URL_PATH);
    await loadTheExample(page);
  });

  test('a quarter turn right goes into the matrix, and every frame is copied as it was', async ({ page }) => {
    test.setTimeout(240_000);

    // The first chip is pressed by default; the page's own line says what
    // the turn will do before anything runs.
    await expect(page.locator('.chip[data-turn="90"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#preview-line')).toContainText(/turned right|on its side/i);

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

    // Six seconds of 25 a second, frame for frame.
    expect(video!.samples, 'the copy does not have the example\'s frame count')
      .toBe(SECONDS * 25);
    expect(video!.codec, 'the copied picture is not the H.264 it was').toBe('avc1');
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.6);
    expect(file.seconds).toBeLessThan(SECONDS + 0.6);

    // The example has AAC sound, which is copied across as it is.
    const sound = audioTrack(file);
    expect(sound, 'the sound track was lost on the copy path').not.toBeNull();
    expect(sound!.codec).toBe('mp4a');
  });

  test('upside down is the other matrix', async ({ page }) => {
    test.setTimeout(240_000);
    await pressChip(page, '[data-turn="180"]');
    await expect(page.locator('#preview-line')).toContainText(/upside down/i);

    const video = videoTrack(readMp4(await runAndSave(page)));
    expect(video).not.toBeNull();
    expect(video!.rotation, 'the display matrix is not an upside-down turn').toBe(180);
    expect(video!.width).toBe(WIDTH);
    expect(video!.height).toBe(HEIGHT);
  });

  test('baking the turn in writes turned frames and no matrix', async ({ page }) => {
    // The other path, and the opposite evidence: the frames themselves are
    // the turned size, and the header says nothing about turning.
    test.setTimeout(300_000);
    await page.locator('#bake').check();
    await expect(page.locator('#preview-line')).toContainText(/turned right|on its side/i);

    const bytes = await runAndSave(page, { timeout: 240_000 });
    const file = readMp4(bytes);
    const video = videoTrack(file);
    expect(video).not.toBeNull();

    expect(video!.rotation, 'a baked clip still carries a rotation in its matrix').toBe(0);
    expect(video!.width, 'the baked frame is not the turned width').toBe(HEIGHT);
    expect(video!.height, 'the baked frame is not the turned height').toBe(WIDTH);
    expect(video!.codec).toBe('avc1');
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.6);
    expect(file.seconds).toBeLessThan(SECONDS + 0.6);
    expect(audioTrack(file), 'baking the picture dropped the sound').not.toBeNull();
  });

  test('leaving the sound out leaves it out', async ({ page }) => {
    test.setTimeout(240_000);
    await page.locator('#drop-audio').check();

    const file = readMp4(await runAndSave(page));
    expect(audioTrack(file), 'the sound track is still there').toBeNull();
    expect(videoTrack(file)?.rotation).toBe(90);
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
