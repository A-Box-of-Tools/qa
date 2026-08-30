import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { canFakeCamera, hasCameraInterface, quiet } from '../../lib/engine';

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
 *
 * AN ENGINE THAT CANNOT BE GIVEN A CAMERA
 *
 * The stub above needs somewhere to be installed and something to hand back,
 * and Playwright's WebKit gives trouble on both counts - differently on
 * different platforms, which is the whole reason the gate below asks rather
 * than names a browser.
 *
 * On the Windows build there is no `navigator.mediaDevices` to put a
 * getUserMedia on and no `canvas.captureStream` to return from it. On the
 * Linux build CI runs, both exist - and the stream captured from a canvas
 * never paints, so `camera.open()` rejects and the camera card never appears.
 * A gate that checked for the two names passed there and left six tests
 * failing on a card that was never going to open.
 *
 * So lib/engine.ts runs the stub's own steps end to end and answers whether
 * they finish with a picture. Real Safari has had all of this for years; this
 * is the test build, not the browser.
 *
 * Where a camera cannot be supplied the describe below is skipped. Where the
 * engine has no camera interface at all - a narrower case, and the one the
 * tool itself can see - a different test runs instead: the reader has to say
 * so, and that is the half of this page such an engine can check.
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
  // Asked once per test, on the reader's own page: mediaDevices is not
  // defined on about:blank whatever the engine, so the question has to be put
  // to a page that was really served.
  test.beforeEach(async ({ page }) => {
    await page.goto(READER);
    test.skip(!await canFakeCamera(page),
      'no camera can be supplied on this engine: a canvas stream never reaches '
      + 'a <video> here, so there is nothing to point the reader at');
  });

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
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'what the camera read was sent').not.toContain(text);
      expect(entry, 'the frame was sent').not.toContain(png.toString('base64').slice(100, 180));
    }
  });
});

/**
 * What the reader says on a browser that has no camera at all.
 *
 * The mirror image of the describe above, and the only part of the camera
 * path such an engine can be asked about. It matters because the answer must
 * not be silence: a Start button that does nothing when pressed is
 * indistinguishable from a broken page, and the reader's whole other half -
 * choosing a picture - still works and needs saying.
 *
 * Deliberately not written as "skip unless WebKit". If a later Playwright
 * build gives WebKit a camera interface, this test stops running and the six
 * above start, which is the correct outcome and needs no edit here.
 */
test.describe('qr-barcode-reader: with no camera interface at all', () => {
  test('says so, rather than doing nothing', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(READER);
    // The narrow question, not canFakeCamera's. This test is about what the
    // reader says when it can see no camera interface, so it has to run
    // exactly where the reader sees none - an engine that has the interface
    // and merely cannot be given a picture says something else, correctly.
    test.skip(await hasCameraInterface(page),
      'this engine offers a camera interface, so this is not the refusal it '
      + 'would give');

    // The offer is still made. A browser can gain a camera between page loads
    // - a plugged-in webcam, a permission granted - and the page cannot know
    // in advance which refusal it will get, so the honest design is to ask
    // and report.
    await expect(page.locator('#start-camera')).toBeVisible();
    await page.locator('#start-camera').click();

    const said = page.locator('#pick-error');
    await expect(
      said,
      'pressing Start on a browser with no camera interface said nothing at all',
    ).toBeVisible({ timeout: 30_000 });

    // Named as the browser's limit rather than as a fault, and not left as a
    // phrase key - which is the failure tests/phrases.spec.ts exists for and
    // which this path, reachable on almost no desktop, would hide well.
    await expect(said).toContainText(/camera interface/i);
    await expect(said).not.toContainText('camera.');

    // And the rest of the tool is still offered, which is the sentence's own
    // claim: "Everything else here still works."
    await expect(page.locator('#file-input')).toBeAttached();
    await expect(page.locator('#dropzone')).toBeVisible();
  });
});
