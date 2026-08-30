import { test, expect, type Page } from '@playwright/test';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the encoder.
 *
 * Every expectation here is computed with Node's own Buffer rather than read
 * off the page, because an encoder is precisely the kind of tool whose wrong
 * answer looks exactly like a right one. The place it goes wrong is the
 * character set: a string pushed through charCodeAt instead of UTF-8 produces
 * a plausible, incorrect result for anything above U+00FF, and the person who
 * finds out is whoever pastes it somewhere that matters.
 *
 * So the fixtures are deliberately not ASCII. 'héllo — 東京 🧰' spans a Latin-1
 * character, an em dash, two CJK characters and an emoji above the basic
 * plane - one string that catches four different ways of getting UTF-8 wrong.
 */

const URL_PATH = '/encode-text/';

const AWKWARD = 'héllo — 東京 🧰';

/** Choose a codec, once the list has been built. */
async function codec(page: Page, id: string): Promise<void> {
  // The select is populated by script rather than markup, so it can be empty
  // for a moment after load - selecting into it too early fails on an option
  // that exists but has not arrived yet.
  await expect(page.locator(`#codec option[value="${id}"]`)).toHaveCount(1, { timeout: 20_000 });
  await page.locator('#codec').selectOption(id);
}

async function direction(page: Page, which: 'encode' | 'decode'): Promise<void> {
  await page.locator(`input[name="direction"][value="${which}"]`).check();
}

/**
 * Type into the main box and read the output back.
 *
 * Clearing first is what makes the reading trustworthy. The output box is
 * already full from whatever ran before, so "wait until it is not empty"
 * is satisfied instantly by the previous answer - which is how the first
 * draft of this file managed to compare base64url's output against base64's
 * and call it a round-trip failure. Empty, then filled, is a state the
 * previous run cannot have left behind.
 */
async function run(page: Page, text: string): Promise<string> {
  await page.locator('#clear').click();
  await expect(page.locator('#output')).toBeEmpty({ timeout: 20_000 });
  await page.locator('#input').fill(text);
  await expect(page.locator('#output')).not.toBeEmpty({ timeout: 20_000 });
  return (await page.locator('#output').textContent()) ?? '';
}

test.describe('encode-text: against Node, not against itself', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('Base64 agrees with Node, including outside ASCII', async ({ page }) => {
    await codec(page, 'base64');
    await direction(page, 'encode');

    const out = (await run(page, AWKWARD)).trim();
    expect(out).toBe(Buffer.from(AWKWARD, 'utf8').toString('base64'));
  });

  test('Base64 decoded is the text that was encoded', async ({ page }) => {
    await codec(page, 'base64');
    await direction(page, 'decode');

    const out = await run(page, Buffer.from(AWKWARD, 'utf8').toString('base64'));
    expect(out.trim()).toBe(AWKWARD);
  });

  test('base64url uses the URL alphabet', async ({ page }) => {
    // The whole point of the variant: + and / must not appear.
    const text = 'ûÿþý';
    await codec(page, 'base64url');
    await direction(page, 'encode');

    const out = (await run(page, text)).trim();
    expect(out).not.toMatch(/[+/]/);
    expect(out).toBe(
      Buffer.from(text, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    );
  });

  test('hex agrees with Node', async ({ page }) => {
    await codec(page, 'hex');
    await direction(page, 'encode');

    const out = (await run(page, AWKWARD)).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    expect(out).toBe(Buffer.from(AWKWARD, 'utf8').toString('hex'));
  });

  test('every codec that claims to reverse actually reverses', async ({ page }) => {
    // One round trip each, rather than a hand-written expectation each: the
    // property that matters for all of them is that decode(encode(x)) is x,
    // and the codecs where that quietly fails are the ones with characters
    // they did not think about.
    for (const id of ['base64', 'base64url', 'hex', 'url', 'escapes']) {
      await codec(page, id);
      await direction(page, 'encode');
      const encoded = (await run(page, AWKWARD)).trim();

      await codec(page, id);
      await direction(page, 'decode');
      const back = await run(page, encoded);

      expect(back.trim(), `${id} did not survive the return trip`).toBe(AWKWARD);
    }
  });
});

test.describe('encode-text: the ones with a point to them', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('HTML escaping covers the characters that matter', async ({ page }) => {
    await codec(page, 'html');
    await direction(page, 'encode');

    const out = await run(page, '<script>alert("x" & \'y\')</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;');
    expect(out).toContain('&gt;');
    expect(out).toContain('&amp;');
  });

  test('the two URL codecs disagree about the characters that separate a URL', async ({ page }) => {
    // Why the tool offers both. Encoding a whole URL must leave the slashes
    // and the colon alone or the URL stops being one; encoding a value to go
    // inside a URL must escape them or the value breaks out of its parameter.
    // If these two ever return the same string, one of them is wrong.
    const url = 'https://example.com/a b?x=1&y=2';

    await codec(page, 'url');
    await direction(page, 'encode');
    const asValue = (await run(page, url)).trim();

    await codec(page, 'url-whole');
    await direction(page, 'encode');
    const asWhole = (await run(page, url)).trim();

    expect(asValue, 'the two URL codecs produced identical output').not.toBe(asWhole);
    // The value form has to escape the separators; the whole-URL form must not.
    expect(asValue).toContain('%3A');
    expect(asWhole).not.toContain('%3A');
    // Both must deal with the space, which is never legal unescaped.
    expect(asValue).not.toContain(' ');
    expect(asWhole).not.toContain(' ');
  });

  test('a decode that cannot work says so rather than inventing something', async ({ page }) => {
    // '!!!!' is not base64. Handing back mojibake would be worse than a
    // refusal, because mojibake gets pasted onwards.
    await codec(page, 'base64');
    await direction(page, 'decode');
    await page.locator('#input').fill('!!!! not base64 !!!!');

    await expect(page.locator('#error')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#error')).not.toBeEmpty();
  });
});

test.describe('encode-text: the promise', () => {
  test('what is typed never appears in a request', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const secret = 'ghp_QAcanary9f3e71dNotForSending';
    await codec(page, 'base64');
    await direction(page, 'encode');
    await run(page, `{"token":"${secret}"}`);
    await quiet(page);

    // Both forms: this tool's whole job is producing the second one, so
    // checking only for the plain text would miss the leak it is most
    // capable of.
    const encoded = Buffer.from(`{"token":"${secret}"}`, 'utf8').toString('base64');
    for (const entry of traffic) {
      expect(entry, 'the pasted text was sent').not.toContain(secret);
      expect(entry, 'the encoded form was sent').not.toContain(encoded.slice(0, 40));
    }
  });
});
