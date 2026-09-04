import { test, expect, type Browser, type Page } from '@playwright/test';
import { onProductionDomain } from '../../lib/site';

/**
 * Tool-level functional tests for Share Text & Files.
 *
 * This is the first tool on the site with a network step, which makes it the
 * first whose privacy claim is not simply "nothing leaves the page". Text and
 * files go from one browser to another over a WebRTC channel; a Cloudflare
 * Worker called the rendezvous introduces the two ends and, the tool says,
 * never sees the content:
 *
 *   "one WebSocket to the rendezvous carrying a few kilobytes of connection
 *   negotiation ... The text and the files travel over the peer-to-peer
 *   channel those blobs negotiate, encrypted end to end, and no byte of them
 *   passes through here."
 *
 * That is a precise claim about a specific socket, so it gets a precise test:
 * every frame on every WebSocket to the rendezvous is captured, from both
 * ends, for a whole share - and the shared text must appear in none of them.
 *
 * The instrument is checked before its silence is believed. A capture that
 * recorded nothing at all would pass that assertion while proving nothing, so
 * the same test requires that frames were captured and that the negotiation
 * really did travel over them.
 *
 * Two browser contexts rather than two pages: a share has two sides and they
 * must not share storage, permissions or a peer connection. They talk over
 * the real rendezvous, because a fake one would test the fake.
 *
 * What is deliberately not here: whether the consent gate's wording matches
 * the moment the rendezvous socket actually opens. It does not - view() opens
 * it on page load, before the reader has agreed to anything - but that is a
 * question about what the page promises rather than about whether the tool
 * works, and this file is for the second kind.
 */

const URL_PATH = '/share-text/';
const RENDEZVOUS = /rendezvous\.a-box-of-tools\.workers\.dev/;
/** The same host the page's own constant names, in tools/share-text/src/main.js. */
const RENDEZVOUS_URL = 'wss://rendezvous.a-box-of-tools.workers.dev';

/** Long, unmistakable, and not a word the page would produce on its own. */
const SECRET = 'QAcanary-7f3e91d4-the-quick-brown-fox-jumps-over-42-lazy-dogs';

/** A link name of our own, so parallel runs cannot collide on the rendezvous. */
const codeWord = (): string => `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Every frame this page sends or receives on a rendezvous socket.
 *
 * Attached before navigation, because the socket opens during the page's own
 * startup and a listener added afterwards would miss the negotiation - which
 * is exactly the traffic under examination.
 */
function captureRendezvous(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', (socket) => {
    if (!RENDEZVOUS.test(socket.url())) return;
    const keep = (payload: string | Buffer) => {
      frames.push(typeof payload === 'string' ? payload : payload.toString('binary'));
    };
    socket.on('framesent', (frame) => keep(frame.payload));
    socket.on('framereceived', (frame) => keep(frame.payload));
  });
  return frames;
}

/**
 * Does the rendezvous admit the origin this page is served from?
 *
 * The worker takes a socket only from the site's own origin, localhost, and
 * the pull-request previews it has been told about (workers/rendezvous/
 * worker.js, `fromOurPage`); anything else is refused before the upgrade,
 * and a page served from such an origin can publish nothing. On production
 * that would be a failure of the worker and is reported as one. Off the
 * production domain it is the environment's shape, not the tool's fault -
 * a preview whose origin the deployed worker does not know yet - and the
 * tests that need a share say so and stand down, rather than fail six times
 * over on every engine for a socket that was never going to open.
 *
 * Asked by trying: one socket as a viewer of a room nobody hosts, which the
 * worker opens and the room then closes. Bounded, because an origin the
 * worker refuses gets an error at once and one it admits answers in well
 * under a second.
 */
async function rendezvousAdmits(page: Page): Promise<boolean> {
  return page.evaluate((url) => new Promise<boolean>((resolve) => {
    const probe = new WebSocket(url);
    const done = (answer: boolean) => { resolve(answer); try { probe.close(); } catch { /* already closed */ } };
    probe.onopen = () => done(true);
    probe.onerror = () => done(false);
    setTimeout(() => done(false), 5_000);
  }), `${RENDEZVOUS_URL}/ws/qa-probe-${Date.now().toString(36)}?role=viewer`);
}

/** Open a sharer, write the text, and publish it. Returns the share link. */
async function publish(
  page: Page,
  { text, code, priv }: { text: string; code: string; priv: boolean },
): Promise<string> {
  await page.goto(URL_PATH);
  if (!onProductionDomain()) {
    test.skip(!(await rendezvousAdmits(page)),
      'the rendezvous does not admit this origin, so nothing can be shared from here; '
      + 'on a preview that means the deployed worker predates workers/rendezvous admitting previews');
  }
  await page.locator('#text').fill(text);
  await page.locator('#code').fill(code);

  // Checked by default: a private share has to be let in one reader at a
  // time. The open case is the simpler one to prove delivery with.
  if (priv) await page.locator('#private').check();
  else await page.locator('#private').uncheck();

  await page.locator('#publish').click();
  await expect(page.locator('#link')).toHaveValue(/share-text/, { timeout: 30_000 });
  return page.locator('#link').inputValue();
}

/** Open a reader on a share link and get past the consent gate. */
async function readerFor(browser: Browser, link: string): Promise<{ page: Page; frames: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const frames = captureRendezvous(page);
  // The link is absolute and points at the site under test; the path and
  // fragment are what matter, so it is followed as given.
  await page.goto(link);
  await expect(page.locator('#view')).toBeVisible({ timeout: 20_000 });
  return { page, frames };
}

test.describe('share-text: the share itself', () => {
  test('an open share reaches a second browser', async ({ browser }) => {
    test.setTimeout(180_000);
    const code = codeWord();

    const sharerContext = await browser.newContext();
    const sharer = await sharerContext.newPage();
    const link = await publish(sharer, { text: SECRET, code, priv: false });

    const { page: reader } = await readerFor(browser, link);
    await reader.locator('#connect').click();

    // The reader has the text, character for character.
    await expect(reader.locator('#panel')).toBeVisible({ timeout: 60_000 });
    await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });

    await sharerContext.close();
    await reader.context().close();
  });

  test('what the sharer types afterwards arrives too', async ({ browser }) => {
    // "Live updates as you type" is the claim; a share that only delivered
    // its opening state would look identical until somebody edited it.
    test.setTimeout(180_000);
    const code = codeWord();
    const later = 'ADDED-AFTER-THE-READER-ARRIVED-8c1f';

    const sharerContext = await browser.newContext();
    const sharer = await sharerContext.newPage();
    const link = await publish(sharer, { text: SECRET, code, priv: false });

    const { page: reader } = await readerFor(browser, link);
    await reader.locator('#connect').click();
    await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });

    await sharer.locator('#text').fill(`${SECRET}\n${later}`);
    await expect(reader.locator('#panel')).toContainText(later, { timeout: 60_000 });

    await sharerContext.close();
    await reader.context().close();
  });
});

test.describe('share-text: the promise', () => {
  test('no byte of the text passes through the rendezvous', async ({ browser }) => {
    // The claim this whole tool rests on, and the one thing about it that a
    // test can actually settle.
    test.setTimeout(180_000);
    const code = codeWord();

    const sharerContext = await browser.newContext();
    const sharer = await sharerContext.newPage();
    const sharerFrames = captureRendezvous(sharer);
    const link = await publish(sharer, { text: SECRET, code, priv: false });

    const { page: reader, frames: readerFrames } = await readerFor(browser, link);
    await reader.locator('#connect').click();
    await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });

    // Give any trailing negotiation a moment to be recorded before judging
    // the silence.
    await reader.waitForTimeout(1000);

    const everything = [...sharerFrames, ...readerFrames];

    // The control. Silence proves nothing unless the microphone was on: if
    // no frame was captured, the assertion below would pass against a socket
    // that carried the entire text in clear.
    expect(
      everything.length,
      'no rendezvous frames were captured at all - this test cannot see the traffic '
      + 'it is making claims about',
    ).toBeGreaterThan(0);

    // And that what was captured really is the negotiation, not some
    // unrelated keepalive - otherwise "the content is not in these frames"
    // is true of the wrong frames.
    const joined = everything.join('\n');
    expect(
      /sdp|candidate|offer|answer/i.test(joined),
      'the captured frames carry no connection negotiation, so the socket that '
      + 'carried it was not the one being watched',
    ).toBe(true);

    // The claim itself, against every frame in both directions.
    for (const frame of everything) {
      expect(frame, 'the shared text appeared in a rendezvous frame').not.toContain(SECRET);
    }

    // A word from the middle of it, in case anything split or re-encoded the
    // text on the way through.
    for (const frame of everything) {
      expect(frame, 'part of the shared text appeared in a rendezvous frame')
        .not.toContain('quick-brown-fox');
    }

    await sharerContext.close();
    await reader.context().close();
  });

  test('the link name reaches the ad script and nobody else', async ({ browser }) => {
    // The link name lives in the URL fragment, which browsers do not send -
    // but adsbygoogle.js reads location.href and puts the whole of it in the
    // url= parameter of its own request. The page says so now, in "What
    // Google loads, and what it is not given": the address is named as the
    // exception, and the private switch as the answer to it.
    //
    // So this no longer asserts that the name never leaves. It asserts where
    // it goes, which is the part that can still go wrong: one more script on
    // the page, or one call home from this origin, and the name is somewhere
    // the page has not accounted for. A documented exception is only worth
    // anything while it stays the only one.
    test.setTimeout(180_000);
    const code = codeWord();

    const sharerContext = await browser.newContext();
    const sharer = await sharerContext.newPage();
    const link = await publish(sharer, { text: SECRET, code, priv: false });
    expect(link, 'the code word is not in the fragment').toContain(`#${code}`);

    const context = await browser.newContext();
    const reader = await context.newPage();
    const carried: string[] = [];
    reader.on('request', (req) => {
      if (req.url().includes(code) || (req.postData() ?? '').includes(code)) {
        carried.push(new URL(req.url()).host);
      }
    });

    await reader.goto(link);
    await expect(reader.locator('#view')).toBeVisible({ timeout: 20_000 });
    await reader.waitForTimeout(6000);

    // Google's ad request is the one place the page says it goes.
    const ALLOWED = /(^|\.)doubleclick\.net$|(^|\.)googlesyndication\.com$/;
    const unexpected = [...new Set(carried)].filter((host) => !ALLOWED.test(host));
    expect(
      unexpected,
      `the link name reached ${unexpected.join(', ')} - a host the page does not `
      + 'account for. Either that is new, or the page owes the reader a sentence.',
    ).toEqual([]);

    // And it must never reach this site's own server, which is the claim the
    // whole tool rests on: the rendezvous matches two ends of a name it is
    // told, and the page it is served from learns nothing.
    const ownHost = new URL(link).host;
    expect(
      [...new Set(carried)],
      'the link name was sent back to the site that served the page',
    ).not.toContain(ownHost);

    await sharerContext.close();
    await context.close();
  });
});

test.describe('share-text: letting people in', () => {
  test('a private share waits to be admitted', async ({ browser }) => {
    test.setTimeout(240_000);
    const code = codeWord();

    const sharerContext = await browser.newContext();
    const sharer = await sharerContext.newPage();
    const link = await publish(sharer, { text: SECRET, code, priv: true });

    const { page: reader } = await readerFor(browser, link);
    await reader.locator('#connect').click();

    // The reader has to say who they are, and wait.
    await expect(reader.locator('#knockrow')).toBeVisible({ timeout: 60_000 });
    await reader.locator('#knock').fill('QA suite, please admit');
    await reader.locator('#send-knock').click();

    // Asserted against #panel, which wraps both the source and formatted
    // views. That is deliberately the strict reading: the question is not
    // whether the text is displayed but whether it reached this browser at
    // all, and a hidden element holding it would mean it had.
    //
    // Before anyone admits them, they must not have the text. This is the
    // half of the test that matters: a private share that delivered first
    // and asked afterwards would pass every other assertion here.
    await expect(sharer.locator('#requests')).toContainText(/QA suite/, { timeout: 60_000 });
    await expect(reader.locator('#panel')).not.toContainText(SECRET);

    // Admit: the first button in the request row, whatever the language
    // calls it - the label comes from a phrase and this suite runs against
    // whichever locale is served.
    await sharer.locator('#requests button').first().click();

    await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });

    await sharerContext.close();
    await reader.context().close();
  });

  test('closing the tab ends the share', async ({ browser }) => {
    // "Closing the tab is the whole of the deletion." A reader arriving
    // afterwards must find nothing, because there is nowhere for it to have
    // been kept.
    test.setTimeout(240_000);
    const code = codeWord();

    const sharerContext = await browser.newContext();
    const sharer = await sharerContext.newPage();
    const link = await publish(sharer, { text: SECRET, code, priv: false });

    // Control first: while the tab is open, the share is reachable. Without
    // this, a link that never worked would pass the real assertion.
    const first = await readerFor(browser, link);
    await first.page.locator('#connect').click();
    await expect(first.page.locator('#panel'))
      .toContainText(SECRET, { timeout: 60_000 });
    await first.page.context().close();

    await sharerContext.close();

    // A reader arriving now. The page may offer to retry, or refuse to
    // connect at all - which of those it does is presentation. What matters
    // is only that the text does not arrive, so this waits for whichever
    // ending comes and then checks the one thing.
    const context = await browser.newContext();
    const second = await context.newPage();
    await second.goto(link);
    await expect(second.locator('#view')).toBeVisible({ timeout: 20_000 });

    const connect = second.locator('#connect');
    if (await connect.isVisible().catch(() => false)) {
      await connect.click().catch(() => { /* a dead share may disable it */ });
    }

    // Bounded, because the assertion is about something never happening.
    await expect(second.locator('#panel')).not.toContainText(SECRET, { timeout: 20_000 });

    await context.close();
  });
});
