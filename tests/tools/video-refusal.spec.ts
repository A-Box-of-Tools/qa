import { test, expect } from '@playwright/test';
import { canEncodeVideo, recordVideo } from '../../lib/browser-video';
import { wasSilent } from '../../lib/engine';

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
    test.setTimeout(60_000);
    await page.goto('/images-to-video/');
    test.skip(await canEncodeVideo(page),
      'this engine can encode video, so there is no refusal to check');

    /*
     * KNOWN FAILING, AND THE BUG IS THE SITE'S: A-Box-of-Tools/qa#58.
     *
     * There are two ways for an engine to have no encoder, and the tool can
     * only speak up in one of them.
     *
     * Where VideoEncoder is simply absent, `pickH264Codec` returns at once and
     * the page says "This browser supports neither WebCodecs nor canvas
     * recording". That is the behaviour under test, and it passes.
     *
     * Where VideoEncoder exists and `isConfigSupported` never returns - the
     * WebKit build CI runs - it does not merely fail to resolve, it blocks the
     * main thread. Nothing in the page runs after that: not the refusal, not
     * the error handler, not the timeout website#295 added, which is a
     * setTimeout and therefore cannot fire either. The tab is finished. QA saw
     * a Create video click that had not returned five minutes later.
     *
     * The fix has to move that query off the main thread, and four of the five
     * tools that make one would need `worker-src blob:` added to their
     * Content-Security-Policy to allow it - which is the site's call to make
     * and not a test's to force.
     *
     * So this is marked as expected to fail on exactly the engines where the
     * page cannot answer, and left as a real test everywhere else. The day the
     * site can speak up there, this goes green and the marking turns the suite
     * red until somebody deletes these lines. That is the point of the marking.
     */
    if (wasSilent(page, 'encode-video')) {
      test.fail(true, 'qa#58: this engine wedges its own main thread on '
        + 'VideoEncoder.isConfigSupported, so the page cannot say anything');
    }

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
    // A click on a page whose main thread has stopped never reports back, so
    // this one is bounded too. Where the page is alive it lands instantly.
    await page.locator('#export').click({ timeout: 20_000 });

    // Twenty seconds, not sixty. The tool answers in three where it can
    // answer at all, and where it cannot the page is wedged and no amount of
    // waiting changes that - it only spends the budget of a suite that has
    // four browser projects to get through.
    const said = page.locator('#error');
    await expect(
      said,
      'pressing Create video on a browser that cannot encode said nothing at all',
    ).toBeVisible({ timeout: 20_000 });
    await expect(said).toContainText(/WebCodecs|recording/i);
  });
});
