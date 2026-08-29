import { test, expect } from '@playwright/test';
import { recordVideo } from '../../lib/browser-video';

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
