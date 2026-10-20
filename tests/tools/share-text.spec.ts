import fs from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { onProductionDomain } from '../../lib/site';
import { liveRendezvous } from '../../lib/rendezvous';
import { unifiedPairingJoin, sessionApproval, reviewPairingRequestLater, expectRequestsNearHostControls } from '../../lib/pairing-approval';

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

/**
 * The rendezvous the page connects to, read from the page's own source rather
 * than repeated here. It has moved once already - from workers.dev to a name
 * under the site's domain (website#361) - and a copy of the old address in
 * this file meant a probe the page's Content-Security-Policy refused, which
 * WebKit reports by throwing, and six tests failing for a host nobody was
 * connecting to any more. Newer sources select a separate service for local
 * builds and previews; older sources still name their one literal endpoint.
 */
const RENDEZVOUS_URL = liveRendezvous('tools/share-text/src/main.js');

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
    if (new URL(socket.url()).origin !== RENDEZVOUS_URL) return;
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
    // A socket the page's Content-Security-Policy refuses is an error event
    // in Chromium and a SecurityError thrown from the constructor in WebKit;
    // either way the page cannot reach the rendezvous from here.
    let probe: WebSocket;
    try {
      probe = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    const done = (answer: boolean) => { resolve(answer); try { probe.close(); } catch { /* already closed */ } };
    probe.onopen = () => done(true);
    probe.onerror = () => done(false);
    setTimeout(() => done(false), 5_000);
  }), `${RENDEZVOUS_URL}/ws/qa-probe-${Date.now().toString(36)}?role=viewer`);
}

/** Observe real transports so simulated page lifecycle events cannot hide a redial. */
async function observeConnections(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const peers: RTCPeerConnection[] = [];
    const NativeSocket = window.WebSocket;
    const NativePeer = window.RTCPeerConnection;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        peers.push(this);
      }
    };
    (window as any).shareTextTransports = { sockets, peers };
  });
}

async function setForeground(page: Page, shown: boolean): Promise<void> {
  await page.evaluate((visible) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, shown);
}

async function continuityAvailable(page: Page): Promise<void> {
  test.skip(await page.locator('[data-phrase="view.reconnecting"]').count() === 0,
    'this deployed page predates bounded same-page Share Text recovery');
}

async function waitForVacantRoom(page: Page, code: string): Promise<void> {
  await expect.poll(() => page.evaluate((url) => new Promise<boolean>((resolve) => {
    let finished = false;
    let timer = 0;
    const probe = new WebSocket(url);
    const done = (vacant: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { probe.close(); } catch { /* already closed */ }
      resolve(vacant);
    };
    probe.onclose = (event) => done(event.code === 4404);
    probe.onmessage = () => done(false);
    probe.onerror = () => done(false);
    timer = window.setTimeout(() => done(false), 2000);
  }), `${RENDEZVOUS_URL}/ws/${code}?role=viewer`),
  { timeout: 15_000, intervals: [250, 500, 1000] }).toBe(true);
}

/** Open a sharer, write the text, and publish it. Returns the share link. */
async function publish(
  page: Page,
  { text, code, priv, local = false }: { text: string; code: string; priv: boolean; local?: boolean },
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
  if (local) await page.locator('#local').check();

  await page.locator('#publish').click();
  await expect(page.locator('#link')).toHaveValue(/share-text/, { timeout: 30_000 });
  return page.locator('#link').inputValue();
}

/** Open a reader on a share link and get past the consent gate. */
async function readerFor(browser: Browser, link: string, observe = false): Promise<{ page: Page; frames: string[] }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (observe) await observeConnections(page);
  const frames = captureRendezvous(page);
  // The link is absolute and points at the site under test; the path and
  // fragment are what matter, so it is followed as given.
  await page.goto(link);
  await expect(page.locator('#view')).toBeVisible({ timeout: 20_000 });
  return { page, frames };
}

async function rowDownload(row: Locator): Promise<Locator> {
  const taggedDownload = row.locator('[data-file-download]');
  const action = await taggedDownload.count() > 0
    ? taggedDownload : row.getByRole('button', { name: 'Download', exact: true });
  await expect(action, 'one Download action must be available for the offered file').toHaveCount(1);
  return action;
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
  test('an approved browser returns without another request, but another browser and a new host session remain private', async ({ browser, browserName }) => {
    test.skip(!sessionApproval, 'Session approvals are awaiting release.');
    test.skip(browserName !== 'chromium', 'The native data-channel journey runs in Chromium.');
    test.setTimeout(150_000);
    const hostContext = await browser.newContext(), readerContext = await browser.newContext(), otherContext = await browser.newContext();
    const host = await hostContext.newPage(), code = codeWord();
    try {
      const link = await publish(host, { text: SECRET, code, priv: true, local: true });
      const connect = async (context: BrowserContext) => {
        const reader = await context.newPage();
        await observeConnections(reader);
        await reader.goto(link);
        await expect(reader.locator('#connect')).toBeVisible();
        expect(await reader.evaluate(() => (window as any).shareTextTransports.peers.length)).toBe(0);
        await expect(reader.locator('#panel')).not.toContainText(SECRET);
        await reader.locator('#connect').click();
        return reader;
      };
      const ask = async (reader: Page, note: string) => {
        await expect(reader.locator('#knockrow')).toBeVisible({ timeout: 30_000 });
        await reader.locator('#knock').fill(note); await reader.locator('#send-knock').click();
        await expect(host.locator('#requests')).toContainText(note, { timeout: 30_000 });
        await expect(reader.locator('#panel')).not.toContainText(SECRET);
        await reviewPairingRequestLater(host);
      };
      const first = await connect(readerContext);
      await ask(first, 'First approved browser');
      await expectRequestsNearHostControls(host, '#text');
      await host.locator('#requests button').first().click();
      await expect(first.locator('#panel')).toContainText(SECRET, { timeout: 30_000 });
      await first.close();
      const returning = await connect(readerContext);
      await expect(returning.locator('#panel')).toContainText(SECRET, { timeout: 30_000 });
      await expect(returning.locator('#knockrow')).toBeHidden();
      await expect(host.locator('#requests button')).toHaveCount(0);
      await expect(host.locator('#pairing-request-dialog')).toBeHidden();
      await host.locator('#text').fill(`${SECRET}\nAn edit after returning`);
      await expect(returning.locator('#panel')).toContainText('An edit after returning');
      const other = await connect(otherContext);
      await ask(other, 'Another browser');
      await host.locator('#requests button').last().click();
      await expect(other.locator('#panel')).not.toContainText(SECRET);
      await returning.close(); await other.close();
      await host.locator('#stop').click();
      // Reusing the very same invitation proves the host's lifetime, rather
      // than a different code alone, is the boundary of the remembered grant.
      await host.locator('#publish').click();
      await expect(host.locator('#link')).toHaveValue(link, { timeout: 30_000 });
      const nextSession = await connect(readerContext);
      await expect(host.locator('#pairing-request-dialog')).toBeVisible({ timeout: 30_000 });
      await expect(nextSession.locator('#panel')).not.toContainText(SECRET);
      await reviewPairingRequestLater(host);
      await expect(host.locator('#requests button')).toHaveCount(2);
      await host.locator('#requests button').first().click();
      await expect(nextSession.locator('#panel')).toContainText(SECRET, { timeout: 30_000 });
      await host.locator('#stop').click();
      await expect(nextSession.locator('#panel')).not.toContainText(SECRET);
    } finally {
      await otherContext.close(); await readerContext.close(); await hostContext.close();
    }
  });

  test('a discovered Join preserves the draft and requests private access once; an ordinary link still waits', async ({ browser, browserName }) => {
    test.skip(!unifiedPairingJoin, 'One-click discovery is awaiting release.');
    test.skip(browserName !== 'chromium', 'The native local data-channel journey runs in Chromium.');
    test.setTimeout(150_000);
    const hostContext = await browser.newContext(), browsingContext = await browser.newContext();
    const host = await hostContext.newPage(), browsing = await browsingContext.newPage();
    const code = codeWord();
    try {
      const link = await publish(host, { text: SECRET, code, priv: true, local: true });
      await browsing.goto(new URL(URL_PATH, link).href);
      await browsing.locator('#text').fill('My unsent draft stays here');
      const row = browsing.locator('#discovery-list .paired-nearby-row').filter({ hasText: code });
      const join = row.getByRole('link');
      await expect(join).toBeVisible({ timeout: 75_000 });
      await expect(join).toHaveText('Join');
      await expect(join).toHaveAccessibleName(`Join ${code} via Direct`);
      const [reader] = await Promise.all([browsingContext.waitForEvent('page'), join.click()]);
      await reader.waitForLoadState();
      await expect(browsing.locator('#text')).toHaveValue('My unsent draft stays here');
      await expect(reader.locator('#connect')).toBeHidden();
      const dialog = host.locator('#pairing-request-dialog');
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(reader.locator('#knockrow')).toBeHidden();
      await expect(reader.locator('#panel')).not.toContainText(SECRET);
      expect(await reader.evaluate(() => sessionStorage.getItem('pairing.discovery-join'))).toBeNull();
      await expect(dialog.locator('[data-approval-later]')).toBeFocused();
      await dialog.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(host.locator('#requests button')).toHaveCount(2);
      await expect(reader.locator('#panel')).not.toContainText(SECRET);
      await host.locator('#requests button').first().click();
      await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 30_000 });
      const ordinary = await readerFor(browser, reader.url(), true);
      try {
        await expect(ordinary.page.locator('#connect')).toBeVisible({ timeout: 20_000 });
        expect(await ordinary.page.evaluate(() => (window as any).shareTextTransports.peers.length)).toBe(0);
        await expect(ordinary.page.locator('#panel')).not.toContainText(SECRET);
      } finally { await ordinary.page.context().close(); }
      await host.locator('#stop').click();
      await expect(host.locator('#requests button')).toHaveCount(0);
      await expect(dialog).toBeHidden();
    } finally {
      await browsingContext.close(); await hostContext.close();
    }
  });

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
    await reviewPairingRequestLater(sharer);
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


test('share-text: private attachments arrive intact only after admission, including an empty file', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  let reader: Page | undefined;
  try {
    const sharer = await context.newPage();
    const frames = captureRendezvous(sharer);
    const link = await publish(sharer, { text: SECRET, code: codeWord(), priv: true });
    const binary = Buffer.concat([Buffer.from('QA-attachment-content-never-in-rendezvous'),
      Buffer.from(Array.from({ length: 200_000 }, (_, at) => at % 256))]);
    const files = [{ name: 'résumé.bin', buffer: binary }, { name: 'empty.bin', buffer: Buffer.alloc(0) }];
    await sharer.locator('#fileinput').setInputFiles(files.map((file) => ({ ...file, mimeType: 'application/octet-stream' })));
    const opened = await readerFor(browser, link);
    reader = opened.page;
    await reader.locator('#connect').click();
    await expect(reader.locator('#knockrow')).toBeVisible({ timeout: 60_000 });
    await expect(reader.locator('#filelist button')).toHaveCount(0);
    await reader.locator('#knock').fill('File QA');
    await reader.locator('#send-knock').click();
    await expect(sharer.locator('#requests')).toContainText('File QA');
    await reviewPairingRequestLater(sharer);
    await sharer.locator('#requests button').first().click();
    await expect(reader.locator('#filelist .filerow')).toHaveCount(2, { timeout: 60_000 });
    for (const file of files) {
      const action = await rowDownload(reader.locator('#filelist .filerow').filter({ hasText: file.name }));
      const [saved] = await Promise.all([
        reader.waitForEvent('download'),
        action.click(),
      ]);
      expect(saved.suggestedFilename()).toBe(file.name);
      expect(fs.readFileSync((await saved.path())!)).toEqual(file.buffer);
    }
    const signaling = [...frames, ...opened.frames].join('\n');
    expect(signaling.length).toBeGreaterThan(0);
    expect(signaling).not.toContain('QA-attachment-content-never-in-rendezvous');
  } finally {
    await context.close();
    await reader?.context().close();
  }
});

test('share-text: stopping a share during a file read never offers a partial download', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  let reader: Page | undefined;
  try {
    const sharer = await context.newPage();
    const link = await publish(sharer, { text: SECRET, code: codeWord(), priv: false });
    await sharer.locator('#fileinput').setInputFiles({ name: 'interrupted.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(200_000, 81) });
    const opened = await readerFor(browser, link);
    reader = opened.page;
    await reader.locator('#connect').click();
    await expect(reader.locator('#filelist .filerow')).toHaveCount(1, { timeout: 60_000 });
    const action = await rowDownload(reader.locator('#filelist .filerow'));
    await sharer.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function () {
        Blob.prototype.arrayBuffer = original;
        const bytes = await original.call(this);
        await new Promise<void>((resolve) => { (window as any).releaseFileRead = resolve; (window as any).fileReadHeld = true; });
        return bytes;
      };
    });
    const downloads: string[] = [];
    reader.on('download', (download) => downloads.push(download.suggestedFilename()));
    await action.click();
    await expect.poll(() => sharer.evaluate(() => Boolean((window as any).fileReadHeld))).toBe(true);
    await sharer.locator('#stop').click();
    await sharer.evaluate(() => (window as any).releaseFileRead());
    await expect(reader.locator('#filelist button')).toHaveCount(0, { timeout: 60_000 });
    await expect(reader.locator('#retryrow')).toBeVisible();
    expect(downloads).toEqual([]);
  } finally {
    await context.close();
    await reader?.context().close();
  }
});

test.describe('share-text: foreground continuity', () => {
  test('a hidden healthy peer survives a host introduction-socket loss', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'native data-channel lifecycle instrumentation is checked in Chromium');
    test.setTimeout(180_000);
    const context = await browser.newContext();
    let reader: Page | undefined;
    try {
      const sharer = await context.newPage();
      await observeConnections(sharer);
      const code = codeWord();
      const link = await publish(sharer, { text: SECRET, code, priv: false });
      await continuityAvailable(sharer);
      const opened = await readerFor(browser, link, true);
      reader = opened.page;
      await reader.locator('#connect').click();
      await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });
      await setForeground(sharer, false);
      await setForeground(reader, false);
      const before = await reader.evaluate(() => (window as any).shareTextTransports.peers.length);
      await sharer.evaluate(() => {
        const socket = (window as any).shareTextTransports.sockets.findLast((ws: WebSocket) =>
          ws.url.includes('role=host') && ws.readyState === WebSocket.OPEN);
        if (!socket) throw new Error('the active host introduction socket was not observed');
        socket.close(1000);
      });
      await expect.poll(() => sharer.evaluate(() => (window as any).shareTextTransports.sockets
        .filter((ws: WebSocket) => ws.url.includes('role=host') && ws.readyState === WebSocket.OPEN).length),
      { timeout: 30_000 }).toBe(1);
      await setForeground(sharer, true);
      await setForeground(reader, true);
      const updated = `${SECRET}\nSTILL-THE-SAME-HIDDEN-PEER`;
      await sharer.locator('#text').fill(updated);
      await expect(reader.locator('#panel')).toContainText(updated, { timeout: 30_000 });
      expect(await reader.evaluate(() => (window as any).shareTextTransports.peers.length)).toBe(before);
      await expect(sharer.locator('#link')).toHaveValue(link);
      expect(opened.frames.some((frame) => /"relay"\s*:\s*true/.test(frame))).toBe(false);
    } finally {
      await context.close();
      await reader?.context().close();
    }
  });

  test('a consented local reader recovers its admission and mode, while Stop stays terminal', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'native data-channel lifecycle instrumentation is checked in Chromium');
    test.setTimeout(240_000);
    const context = await browser.newContext();
    let reader: Page | undefined;
    let replacementReader: Page | undefined;
    try {
      const sharer = await context.newPage();
      await observeConnections(sharer);
      const code = codeWord();
      const link = await publish(sharer, { text: SECRET, code, priv: true, local: true });
      await continuityAvailable(sharer);
      await sharer.locator('#markdown').check();
      const file = Buffer.alloc(200_000, 73);
      await sharer.locator('#fileinput').setInputFiles({ name: 'fresh-request.bin', mimeType: 'application/octet-stream', buffer: file });
      const opened = await readerFor(browser, link, true);
      reader = opened.page;
      await expect(reader.locator('#consent')).toBeVisible({ timeout: 30_000 });
      await setForeground(reader, false);
      await setForeground(reader, true);
      await reader.waitForTimeout(300);
      expect(await reader.evaluate(() => (window as any).shareTextTransports.peers.length)).toBe(0);
      await reader.evaluate(() => {
        Object.defineProperty(window, 'sessionStorage', { configurable: true,
          get() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
      });
      await reader.locator('#connect').click();
      await expect(reader.locator('#knockrow')).toBeVisible({ timeout: 60_000 });
      await reader.locator('#knock').fill('Same-page continuation');
      await reader.locator('#send-knock').click();
      await expect(sharer.locator('#requests')).toContainText('Same-page continuation');
      await reviewPairingRequestLater(sharer);
      await sharer.locator('#requests button').first().click();
      await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });
      await reader.locator('#mode-src').click();
      await sharer.evaluate(() => {
        const original = Blob.prototype.arrayBuffer;
        let reads = 0;
        Blob.prototype.arrayBuffer = async function () {
          reads += 1;
          if (reads !== 2) return original.call(this);
          Blob.prototype.arrayBuffer = original;
          const bytes = await original.call(this);
          await new Promise<void>((resolve) => {
            (window as any).releaseRecoveryFile = resolve;
            (window as any).recoveryFileHeld = true;
          });
          return bytes;
        };
      });
      const downloads: string[] = [];
      reader.on('download', (download) => downloads.push(download.suggestedFilename()));
      await expect(reader.locator('#filelist .filerow')).toHaveCount(1);
      const partial = await rowDownload(reader.locator('#filelist .filerow'));
      const downloadLabel = (await partial.textContent()) ?? '';
      await partial.click();
      await expect.poll(() => sharer.evaluate(() => Boolean((window as any).recoveryFileHeld))).toBe(true);
      await expect(partial).toContainText(/%/);
      const before = await reader.evaluate(() => (window as any).shareTextTransports.peers.length);
      await setForeground(reader, false);
      await reader.evaluate(() => {
        const peer = (window as any).shareTextTransports.peers.findLast((pc: RTCPeerConnection) => pc.connectionState === 'connected');
        if (!peer) throw new Error('the connected native reader peer was not observed');
        peer.close();
      });
      await expect(reader.locator('#panel')).not.toContainText(SECRET);
      await setForeground(reader, true);
      await expect(reader.locator('#panel')).toContainText(SECRET, { timeout: 60_000 });
      expect(await reader.evaluate(() => (window as any).shareTextTransports.peers.length)).toBeGreaterThan(before);
      await expect(reader.locator('#received')).toBeVisible();
      await expect(reader.locator('#knock')).toHaveValue('Same-page continuation');
      await expect(sharer.locator('#requests button')).toHaveCount(0);
      await expect(reader.locator('#consent')).toBeHidden();
      expect(new URL(reader.url()).searchParams.get('local')).toBe('1');
      expect(await reader.evaluate(() => (window as any).shareTextTransports.peers.at(-1).getConfiguration().iceServers)).toEqual([]);
      expect(opened.frames.some((frame) => /"relay"\s*:\s*true/.test(frame))).toBe(false);
      await sharer.evaluate(() => (window as any).releaseRecoveryFile());
      await expect(reader.locator('#filelist .filerow')).toHaveCount(1);
      const fresh = await rowDownload(reader.locator('#filelist .filerow'));
      await expect(fresh).toHaveText(downloadLabel);
      expect(downloads).toEqual([]);
      const [saved] = await Promise.all([reader.waitForEvent('download'), fresh.click()]);
      expect(fs.readFileSync((await saved.path())!)).toEqual(file);

      const hostBeforeStop = await sharer.evaluate(() => {
        const sockets: WebSocket[] = (window as any).shareTextTransports.sockets;
        return { index: sockets.map((ws) => ws.url.includes('role=host') && ws.readyState === WebSocket.OPEN).lastIndexOf(true),
          count: sockets.filter((ws) => ws.url.includes('role=host')).length };
      });
      expect(hostBeforeStop.index).toBeGreaterThanOrEqual(0);
      await sharer.locator('#stop').click();
      await expect(reader.locator('#panel')).not.toContainText(SECRET, { timeout: 30_000 });
      await expect(reader.locator('#retryrow')).toBeVisible();
      // Native close handshakes can outlast the page's terminal control.
      // The current socket must begin closing; room retirement is checked
      // separately against the rendezvous rather than inferred from CLOSED.
      await expect.poll(() => sharer.evaluate((index) => (window as any).shareTextTransports.sockets[index].readyState,
        hostBeforeStop.index)).toBeGreaterThanOrEqual(2);
      await waitForVacantRoom(sharer, code);
      const stopped = await reader.evaluate(() => ({ peers: (window as any).shareTextTransports.peers.length,
        sockets: (window as any).shareTextTransports.sockets.length }));
      await setForeground(reader, false);
      await setForeground(reader, true);
      await reader.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await setForeground(sharer, false);
      await setForeground(sharer, true);
      await sharer.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      expect(await sharer.evaluate(() => (window as any).shareTextTransports.sockets
        .filter((ws: WebSocket) => ws.url.includes('role=host')).length)).toBe(hostBeforeStop.count);
      const replacement = 'A-NEW-PRIVATE-SHARE-IS-NOT-THE-OLD-ADMISSION';
      await sharer.locator('#text').fill(replacement);
      await sharer.locator('#publish').click();
      await expect(sharer.locator('#stop')).toBeVisible();
      replacementReader = (await readerFor(browser, link)).page;
      await replacementReader.locator('#connect').click();
      await expect(replacementReader.locator('#knockrow')).toBeVisible({ timeout: 60_000 });
      await expect(replacementReader.locator('#panel')).not.toContainText(replacement);
      // Longer than the recovery delay: a late queued retry must not dial
      // the new share under the old name or silently reuse its old admission.
      await reader.waitForTimeout(6500);
      expect(await reader.evaluate(() => ({ peers: (window as any).shareTextTransports.peers.length,
        sockets: (window as any).shareTextTransports.sockets.length }))).toEqual(stopped);
      expect(await sharer.evaluate(() => (window as any).shareTextTransports.sockets
        .filter((ws: WebSocket) => ws.url.includes('role=host')).length)).toBe(hostBeforeStop.count + 1);
      await expect(reader.locator('#panel')).not.toContainText(replacement);
      await expect(sharer.locator('#requests button')).toHaveCount(0);
    } finally {
      await context.close();
      await reader?.context().close();
      await replacementReader?.context().close();
    }
  });
});
