import { test, expect } from '@playwright/test';
import { canEncodeAac, canEncodeVideo, recordVideo } from '../../lib/browser-video';
import { audioTrack, isMp4, readMp4, videoTrack } from '../../lib/mp4';
import { loadFile, loadTheExample, runAndSave } from '../../lib/tool-frame';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the MP4 converter.
 *
 * WHAT THE TOOL PROMISES
 *
 * One thing, deliberately: H.264 picture and AAC sound in a plain MP4,
 * whatever came in. A track that is already that is copied across untouched;
 * one that is not is decoded and encoded again; and the page says which
 * before it starts.
 *
 * WHAT IS CHECKED, AND WITH WHAT
 *
 * The example the page ships is the case the tool exists for: a WebM with
 * VP8 picture and Opus sound, the file every browser screen recorder writes
 * and few things accept. What comes out is opened with lib/mp4.ts and held
 * to the promise by its sample entries - avc1 and mp4a, nothing else - and
 * to the input by its size and length. The other path is given an H.264
 * clip the browser under test recorded, so that "copied" can be checked as
 * a fact about the file rather than a word on the page: the same number of
 * samples out as in.
 *
 * The page's own "opened it again to check" line is required to be green,
 * because a run the tool did not trust is a failure, and then ignored.
 */

const URL_PATH = '/convert-to-mp4/';

const SHIPPED = discoverTools().includes('convert-to-mp4');
const NOT_YET = 'this site does not ship convert-to-mp4 yet';

/** The example recording: 960 x 540, 25 a second, eight seconds, with sound. */
const WIDTH = 960;
const HEIGHT = 540;
const SECONDS = 8;

test.describe('convert-to-mp4: the recording it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    test.skip(!await canEncodeVideo(page),
      'this engine can write no video, so the example cannot be built and nothing can be re-encoded');
    await page.goto(URL_PATH);
    await loadTheExample(page);
  });

  test('a WebM of VP8 and Opus comes out as H.264 and AAC in an MP4', async ({ page }) => {
    test.setTimeout(300_000);

    // The plan is the page's contract with the visitor: what changes, and
    // what does not, said before a frame is touched. The sound half depends
    // on the engine: Opus has to be encoded again as AAC, and Chromium on
    // the Linux runners has no AAC encoder, in which case the honest plan
    // is that the sound is left out - the page ticks the box itself and
    // says so - and the honest file has no sound track. Both are held to.
    const aac = await canEncodeAac(page);
    await expect(page.locator('#file-facts')).toContainText(/WebM/i);
    await expect(page.locator('#plan-picture')).toContainText(/H\.264/);
    await expect(page.locator('#plan-picture')).toContainText(/VP8/);
    if (aac) {
      await expect(page.locator('#plan-sound')).toContainText(/AAC/);
    } else {
      await expect(page.locator('#plan-sound'), 'no AAC encoder, and the plan did not say the sound goes')
        .toContainText(/left out/i);
      await expect(page.locator('#drop-audio')).toBeChecked();
    }

    const bytes = await runAndSave(page, { timeout: 240_000 });
    expect(isMp4(bytes), 'the converted file is not an MP4').toBe(true);

    const file = readMp4(bytes);
    expect(file.fragmented, 'the converter wrote a fragmented file').toBe(false);

    const video = videoTrack(file);
    expect(video, 'no video track in the result').not.toBeNull();
    expect(video!.codec, 'the picture is not H.264').toBe('avc1');
    expect(video!.width).toBe(WIDTH);
    expect(video!.height).toBe(HEIGHT);
    expect(video!.rotation).toBe(0);
    // Eight seconds of 25 a second, and the file says so.
    expect(video!.samples).toBe(SECONDS * 25);
    expect(file.seconds).toBeGreaterThan(SECONDS - 0.6);
    expect(file.seconds).toBeLessThan(SECONDS + 0.6);

    const sound = audioTrack(file);
    if (aac) {
      expect(sound, 'the sound was lost').not.toBeNull();
      expect(sound!.codec, 'the sound is not AAC').toBe('mp4a');
      expect(sound!.seconds).toBeGreaterThan(SECONDS - 1);
    } else {
      expect(sound, 'no AAC encoder, and the file still has a sound track in it').toBeNull();
    }
  });

  test('leaving the sound out leaves it out', async ({ page }) => {
    test.setTimeout(300_000);
    await page.locator('#drop-audio').check();
    await expect(page.locator('#plan-sound')).toContainText(/left out/i);

    const file = readMp4(await runAndSave(page, { timeout: 240_000 }));
    expect(audioTrack(file), 'the sound track is still there').toBeNull();
    expect(videoTrack(file)?.codec).toBe('avc1');
  });
});

test.describe('convert-to-mp4: a clip that is already what an MP4 wants', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('H.264 in an MP4 is copied frame for frame, and the page says so', async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!await canEncodeVideo(page),
      'this engine can record no video, so there is no H.264 clip to hand in');
    await page.goto(URL_PATH);

    const { bytes: recorded } = await recordVideo(page, {
      width: 320, height: 240, seconds: 3, fps: 20,
    });
    const before = videoTrack(readMp4(recorded));
    expect(before, 'the recording has no video track').not.toBeNull();

    await loadFile(page, { name: 'already.mp4', mimeType: 'video/mp4', buffer: recorded });

    await expect(page.locator('#plan-picture')).toContainText(/copied/i);
    await expect(page.locator('#plan-sound')).toContainText(/no sound/i);
    await expect(page.locator('#plan-note')).toContainText(/nothing is re-encoded/i);

    const file = readMp4(await runAndSave(page));
    const after = videoTrack(file);
    expect(after).not.toBeNull();
    expect(after!.codec).toBe('avc1');
    expect(after!.width).toBe(320);
    expect(after!.height).toBe(240);
    // "Copied" as a fact about the file: the same frames, one each.
    expect(after!.samples, 'the copy does not have the frames it was given').toBe(before!.samples);
    expect(audioTrack(file)).toBeNull();
  });
});
