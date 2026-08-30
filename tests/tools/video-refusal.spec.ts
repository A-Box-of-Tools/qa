import { test, expect } from '@playwright/test';
import { canEncodeVideo, recordVideo } from '../../lib/browser-video';

/**
 * What a video tool says in a browser that cannot decode video.
 *
 * Its own file, because video.spec.ts skips itself wholesale where WebCodecs
 * is missing - correctly, since there is nothing to learn about turning a
 * clip into a GIF on an engine that cannot read one - and this is the test
 * that only that engine can run.
 *
 * Playwright's WebKit build has no VideoDecoder, VideoEncoder, MediaRecorder
 * or OffscreenCanvas, which makes it the one place this is checkable. Not a
 * statement about Safari: 17 and newer have WebCodecs. What is being checked
 * is the tool's manners when the browser cannot do the work, and those should
 * be the same whichever browser that turns out to be.
 */
test.describe('a browser that cannot decode video', () => {
  test('is told so, rather than left waiting', async ({ page }) => {
    // The other side of the skip above. Where WebCodecs is missing there is
    // nothing to test about turning a clip into a GIF - but there is
    // something to test about saying so, and this is the only engine that can
    // check it. A tool that quietly did nothing here would look identical to
    // one still working.
    test.setTimeout(180_000);
    await page.goto('/video-to-gif/');
    const canDecode = await page.evaluate(
      () => typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === 'function');
    test.skip(canDecode, 'this engine decodes video, so there is no refusal to check');

    // A real clip, not arbitrary bytes. The tool checks the container first
    // and says "This is not an MP4 or MOV file" to rubbish, which is a
    // different and equally correct refusal - the one under test here is the
    // one about the browser, and only a genuine video reaches it.
    //
    // recordVideo borrows a Chromium to make it, this engine having no
    // MediaRecorder either.
    const clip = await recordVideo(page, { seconds: 2 });
    await page.locator('#file-input').setInputFiles({
      name: 'clip.mp4', mimeType: clip.mimeType, buffer: clip.bytes,
    });

    const said = page.locator('#error, #load-error');
    await expect(said.first()).toBeVisible({ timeout: 30_000 });
    await expect(
      said.first(),
      'the page refused the file without saying the browser was the reason',
    ).toContainText(/WebCodecs/i);
  });
});

/**
 * And the tools that write a video rather than read one.
 *
 * The mirror of the file above, and the assertion that keeps video-more.spec's
 * skip honest. That file now steps aside wherever the engine can encode
 * nothing, which is right - there is no result to inspect - but a skip alone
 * would hide the difference between a tool that says so and a tool that sits
 * there. CI saw the second: a Create video button whose click had not returned
 * five minutes later.
 *
 * This is the sentence that must be there instead.
 */
test.describe('a browser that cannot write video', () => {
  test('images-to-video says so instead of trying', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/images-to-video/');
    test.skip(await canEncodeVideo(page),
      'this engine can encode video, so there is no refusal to check');

    const { encodePng } = await import('../../lib/image-fixtures');
    await page.locator('#file-input').setInputFiles([0, 1].map((index) => ({
      name: `shot-${index}.png`,
      mimeType: 'image/png',
      buffer: encodePng(320, 240, () => (index ? [220, 40, 40] : [40, 200, 60])),
    })));
    await expect(page.locator('#image-list li').first()).toBeVisible({ timeout: 60_000 });

    // The button is offered rather than disabled, which is the right choice:
    // what a browser will encode is not reliably knowable until it is asked,
    // and a permanently greyed button explains nothing.
    await expect(page.locator('#export')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#export').click();

    const said = page.locator('#error');
    await expect(
      said,
      'pressing Create video on a browser that cannot encode said nothing at all',
    ).toBeVisible({ timeout: 60_000 });
    await expect(said).toContainText(/WebCodecs|recording/i);
  });
});
