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
    // Room for the capability probe's own page and deadline as well as this
    // one's waits. A failure here should be an assertion that says what went
    // wrong, not a budget that ran out while one was being evaluated.
    test.setTimeout(90_000);
    await page.goto('/images-to-video/');
    test.skip(await canEncodeVideo(page),
      'this engine can encode video, so there is no refusal to check');

    /*
     * THIS WAS MARKED EXPECTED-TO-FAIL, AND THE MARKING DID NOT WORK.
     *
     * There are two ways for an engine to have no encoder. Where VideoEncoder
     * is absent the tool says "This browser supports neither WebCodecs nor
     * canvas recording" at once. Where it exists and `isConfigSupported`
     * blocks the main thread - the WebKit build CI runs - the page used to
     * stop dead instead, so this was wrapped in `test.fail()` and left to go
     * green the day the site could speak up there.
     *
     * `test.fail()` cannot express that. It expects a status of `failed`, and
     * a wedged page ends a test in `timedOut`, which Playwright counts as an
     * unexpected failure whatever the marking says. Worse, which of the two a
     * run got was luck: an engine that crashed the renderer produced an error
     * and counted as expected, one that merely froze produced a timeout and
     * turned the suite red. Same site, same test, opposite results - qa#83,
     * #90, #91 and #92 are all this one case, opened and closed on alternate
     * nights.
     *
     * So there is no marking any more. website#370 moved the question to a
     * worker, which is the only place a deadline on it can be kept, and the
     * page now refuses on every engine that cannot encode. This asserts that,
     * and a page that wedges again is a real failure and should be red.
     */

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
    // this one is bounded - and its failure is caught rather than thrown,
    // because on the engine this test exists for the click is the thing that
    // wedges, and a timeout raised here would end the test before the line
    // that can say why. Where the page is alive it lands instantly.
    const clicked = await page.locator('#export').click({ timeout: 20_000 })
      .then(() => null, (error: unknown) => error);

    // Is the page still running at all? Asked in words, because it is the
    // question this whole test is about and because everything after a wedge
    // fails for the same reason without naming it - the click, the refusal,
    // the snapshot the reporter takes afterwards, the fixture teardown. A
    // report that blames whichever of those ran out of time first sends the
    // reader to the wrong line.
    //
    // Bounded from out here rather than by a timeout on the call, like every
    // probe in lib/engine.ts: a page that has stopped will not honour one, and
    // a timer in this process is not on the thread that stopped.
    const alive = await Promise.race([
      page.evaluate(() => true).catch(() => false),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 10_000); }),
    ]);
    expect(
      alive,
      'pressing Create video stopped the page: its main thread never came back, '
      + 'so the tool could not have said anything whatever it meant to say',
    ).toBe(true);

    // The page is alive, so a click that still failed did so for some reason
    // of its own and that reason is worth reading as it was raised.
    if (clicked !== null) throw clicked;

    // Twenty seconds, not sixty. The tool answers in about two where it can
    // answer at all - one worker deadline, and pickH264Codec stops at the
    // first silence rather than paying it nine times - and where it cannot,
    // waiting longer only spends the budget of a suite with four browser
    // projects to get through.
    const said = page.locator('#error');
    await expect(
      said,
      'pressing Create video on a browser that cannot encode said nothing at all',
    ).toBeVisible({ timeout: 20_000 });
    await expect(said).toContainText(/WebCodecs|recording/i);
  });
});
