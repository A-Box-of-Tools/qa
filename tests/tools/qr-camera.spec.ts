import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';

/**
 * Tool-level functional tests for the QR reader's camera path.
 *
 * The file path is covered by tests/tools/qr-barcode.spec.ts, which encodes a
 * code and reads it back. This is the other half: pointing a camera at one.
 *
 * HOW THE CAMERA IS SUPPLIED, AND WHY NOT CHROME'S FAKE DEVICE
 *
 * Chrome has --use-fake-device-for-media-stream, and it is easy to turn on -
 * it was never the obstacle. It is simply the wrong tool here: the fake device
 * produces a rolling colour pattern, and a pattern with no code in it can only
 * test that nothing was found. Feeding it a specific picture needs
 * --use-file-for-fake-video-capture and a Y4M file generated before the
 * browser launches, which means either a committed binary or a global setup
 * step, for a stream that would still be less controllable than this.
 *
 * So getUserMedia is replaced, before the page's own scripts run, with one
 * that returns a canvas stream showing a QR code this suite just made with the
 * generator. Everything past that boundary is the tool's real code on real
 * objects: canvas.captureStream() gives a genuine MediaStream whose tracks
 * genuinely stop, srcObject genuinely takes it, and getCapabilities() reports
 * genuinely no torch - which is what a webcam without one reports too.
 *
 * What this does not cover, and is not claimed to: the permission prompt, and
 * whether a real camera can be opened at all. Those are the browser's, not the
 * tool's.
 */

const ENCODER = '/qr-barcode/';
const READER = '/qr-barcode-reader/';

/** Make a QR with the generator and return the PNG. */
async function makeQr(page: Page, text: string): Promise<Buffer> {
  await page.goto(ENCODER);
  await page.locator('#symbology').selectOption('qr');
  await page.locator('#field-text').fill(text);
  // Big, so it survives being drawn into a video frame.
  await page.locator('#size').fill('512');

  const pending = page.waitForEvent('download');
  await page.locator('#download-png').click();
  const saved = await pending;
  const path = await saved.path();
  if (!path) throw new Error('the generator saved no PNG');
  return fs.readFileSync(path);
}

/**
 * Point the page's camera at a picture.
 *
 * `devices` decides how many cameras enumerateDevices reports, so the picker
 * can be tested with more than one without needing more than one.
 */
async function fakeCamera(page: Page, png: Buffer, devices = 1): Promise<void> {
  await page.addInitScript(({ base64, devices }) => {
    const dataUrl = `data:image/png;base64,${base64}`;

    const media = navigator.mediaDevices as MediaDevices;

    media.getUserMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;

      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('the fake camera could not load its picture'));
        image.src = dataUrl;
      });

      // Redrawn every frame: a captured stream of a canvas that is never
      // painted again produces one frame and then nothing, and a reader that
      // scans on a timer would have nothing to scan.
      const paint = () => {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 100, 20, 440, 440);
        requestAnimationFrame(paint);
      };
      paint();

      return canvas.captureStream(30);
    };

    media.enumerateDevices = async () => Array.from({ length: devices }, (_, index) => ({
      deviceId: `fake-${index}`,
      groupId: `group-${index}`,
      kind: 'videoinput' as MediaDeviceKind,
      label: index === 0 ? 'Front camera' : `Camera ${index + 1}`,
      toJSON() { return this; },
    })) as MediaDeviceInfo[];
  }, { base64: png.toString('base64'), devices });
}

/** Start the camera and wait for the page to be showing it. */
async function startCamera(page: Page): Promise<void> {
  await page.locator('#start-camera').click();
  await expect(page.locator('#camera-card')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const video = document.getElementById('video') as HTMLVideoElement | null;
    return Boolean(video?.srcObject && video.videoWidth > 0);
  }, undefined, { timeout: 30_000 });
}

test.describe('qr-barcode-reader: reading through the camera', () => {
  test('a code held in front of the camera is read', async ({ page }) => {
    // The round trip the file path already makes, made through a video stream
    // instead: the generator writes it, the camera sees it, the reader says
    // what it says.
    test.setTimeout(180_000);
    const text = 'CAMERA ROUND TRIP 42';
    const png = await makeQr(page, text);

    await fakeCamera(page, png);
    await page.goto(READER);
    await startCamera(page);

    await expect(page.locator('#results-card')).toBeVisible({ timeout: 60_000 });
    const result = page.locator('#results .result').first();
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result.locator('.result-text')).toHaveText(text, { timeout: 60_000 });
  });

  test('stopping the camera lets go of it', async ({ page }) => {
    // A tool that leaves the track running leaves the camera light on, which
    // is the one camera bug users notice immediately and never forgive.
    test.setTimeout(180_000);
    const png = await makeQr(page, 'STOP TEST');

    await fakeCamera(page, png);
    await page.goto(READER);
    await startCamera(page);

    // Hold on to the track so its state can be read after the page drops it.
    await page.evaluate(() => {
      const video = document.getElementById('video') as HTMLVideoElement;
      (window as unknown as { __track: MediaStreamTrack })
        .__track = (video.srcObject as MediaStream).getVideoTracks()[0];
    });

    await page.locator('#stop-camera').click();

    await page.waitForFunction(() => {
      const video = document.getElementById('video') as HTMLVideoElement | null;
      const track = (window as unknown as { __track?: MediaStreamTrack }).__track;
      return video?.srcObject === null && track?.readyState === 'ended';
    }, undefined, { timeout: 30_000 });

    await expect(page.locator('#stop-camera')).toBeHidden();
    await expect(page.locator('#start-camera')).toBeVisible();
  });

  test('one camera needs no chooser; several get one', async ({ page }) => {
    test.setTimeout(180_000);
    const png = await makeQr(page, 'PICKER TEST');

    await fakeCamera(page, png, 1);
    await page.goto(READER);
    await startCamera(page);
    await expect(page.locator('#camera-pick-row')).toBeHidden();
  });

  test('a second camera puts a chooser on the page', async ({ page }) => {
    test.setTimeout(180_000);
    const png = await makeQr(page, 'PICKER TEST');

    await fakeCamera(page, png, 2);
    await page.goto(READER);
    await startCamera(page);

    await expect(page.locator('#camera-pick-row')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#camera-pick option')).toHaveCount(2);
  });

  test('a camera with no lamp is not offered a torch switch', async ({ page }) => {
    // A canvas track reports no torch capability, exactly as a webcam without
    // one does, so the row has to stay away rather than offering a control
    // that would do nothing.
    test.setTimeout(180_000);
    const png = await makeQr(page, 'TORCH TEST');

    await fakeCamera(page, png);
    await page.goto(READER);
    await startCamera(page);

    await expect(page.locator('#torch-row')).toBeHidden();
  });

  test('nothing from the camera leaves the page', async ({ page }) => {
    // The claim matters more here than on the file path: a camera stream is
    // the one input a reader could send somewhere without the reader ever
    // having chosen a file.
    test.setTimeout(180_000);
    const text = 'PRIVATE CAMERA PAYLOAD 9f3e';
    const png = await makeQr(page, text);

    await fakeCamera(page, png);
    await page.goto(READER);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await startCamera(page);
    await expect(page.locator('#results .result').first()).toBeVisible({ timeout: 60_000 });
    await page.waitForLoadState('networkidle');

    for (const entry of traffic) {
      expect(entry, 'what the camera read was sent').not.toContain(text);
      expect(entry, 'the frame was sent').not.toContain(png.toString('base64').slice(100, 180));
    }
  });
});
