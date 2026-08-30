import { test, expect, type Page } from '@playwright/test';
import { SYMBOL_SETS, LOOKALIKES } from '../../lib/password-generator';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the Password & Passphrase Generator:
 * does the page do what tools/password-generator/README.md says it does?
 *
 * etoolbox's own tests/js/password.test.js already covers generate.js,
 * random.js, strength.js and wordlist.js directly, and does it better than a
 * browser can - it can substitute crypto.getRandomValues to prove the modulo
 * rejection, and brute-force the strength formula against enumeration. None
 * of that is repeated here.
 *
 * What this adds is the half no unit test reaches: that the controls on the
 * page are actually wired to that logic, that the page reports what it
 * computed, and - the claim this particular tool lives or dies on - that the
 * secret it just made goes nowhere. Every setting change regenerates, so each
 * test sets its controls and reads the result straight back.
 */

const URL_PATH = '/password-generator/';

/** Range inputs can't be filled like a text box; set and fire the event the page listens for. */
async function setRange(page: Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** The headline result - the one in #secret, not the batch under it. */
async function secret(page: Page): Promise<string> {
  return (await page.locator('#secret').textContent()) ?? '';
}

/** Every result on the page: the headline one, then the batch. */
async function allResults(page: Page): Promise<string[]> {
  const first = await secret(page);
  const rest = await page.locator('#batch li').allTextContents();
  return [first, ...rest];
}

/**
 * Whether `haystack` carries `value` in any form it could plausibly be sent in.
 *
 * A plain `includes` is not enough and quietly gives a false pass: anything
 * put in a query string is percent-encoded, so a password of `^*Hl{%O&...`
 * travels as `%5E*Hl%7B%25O%26...` and never matches the raw string. Worse,
 * whether it matched would depend on which characters that particular draw
 * happened to contain - passing for an alphanumeric password and failing for
 * a symbol-heavy one. Decoding the haystack, and also looking for the
 * base64 a body might carry, is what gives this check teeth.
 */
function carries(haystack: string, value: string): boolean {
  if (haystack.includes(value)) return true;

  try {
    if (decodeURIComponent(haystack).includes(value)) return true;
  } catch {
    // A malformed escape sequence in unrelated traffic; the raw check stands.
  }

  const base64 = Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '');
  return haystack.includes(base64);
}

/** Leave only the named character classes switched on. */
async function onlyClasses(page: Page, keep: string[]): Promise<void> {
  for (const id of ['use-lower', 'use-upper', 'use-digits', 'use-symbols']) {
    const box = page.locator(`#${id}`);
    if (keep.includes(id)) await box.check();
    else await box.uncheck();
  }
}

test.describe('password-generator: password mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('makes a password without being asked', async ({ page }) => {
    // The page generates on boot - there is no "generate" step to press first.
    await expect(page.locator('#secret')).not.toBeEmpty();
    expect((await secret(page)).length).toBeGreaterThan(0);
  });

  test('the length slider sets the length exactly', async ({ page }) => {
    for (const length of [6, 20, 64, 128]) {
      await setRange(page, 'length', length);
      await expect(page.locator('#length-out')).toHaveText(String(length));
      expect(await secret(page), `at length ${length}`).toHaveLength(length);
    }
  });

  test('switching a class off takes it out of the alphabet', async ({ page }) => {
    await setRange(page, 'length', 128);

    await onlyClasses(page, ['use-lower']);
    expect(await secret(page)).toMatch(/^[a-z]+$/);

    await onlyClasses(page, ['use-digits']);
    expect(await secret(page)).toMatch(/^[0-9]+$/);

    await onlyClasses(page, ['use-upper']);
    expect(await secret(page)).toMatch(/^[A-Z]+$/);
  });

  test('the safe symbol set uses only symbols every site accepts', async ({ page }) => {
    await setRange(page, 'length', 128);
    await onlyClasses(page, ['use-symbols']);
    await page.locator('#symbol-set').selectOption('safe');

    // The page also shows the reader which symbols those are; it should agree
    // with what it then draws from.
    await expect(page.locator('#symbol-chars')).toHaveText(SYMBOL_SETS.safe);

    const chars = new Set(await secret(page));
    for (const ch of chars) {
      expect(SYMBOL_SETS.safe, `drew ${JSON.stringify(ch)}`).toContain(ch);
    }
  });

  test('avoiding look-alikes really drops Il1|O0', async ({ page }) => {
    await setRange(page, 'length', 128);
    await page.locator('#avoid-lookalikes').check();

    // 128 characters over four classes, ten times over: if any of the six were
    // still reachable this would find it.
    for (let i = 0; i < 10; i += 1) {
      const value = await secret(page);
      for (const ch of LOOKALIKES) {
        expect(value, `look-alike ${JSON.stringify(ch)} survived`).not.toContain(ch);
      }
      await page.locator('#regenerate').click();
    }
  });

  test('"at least one of each" holds even at the shortest length', async ({ page }) => {
    // Six characters across all four classes is the tightest this page can be
    // set to - the case the README puts at about one candidate in twenty, and
    // so the one where a rejection loop that quietly gave up would show.
    await setRange(page, 'length', 6);
    await onlyClasses(page, ['use-lower', 'use-upper', 'use-digits', 'use-symbols']);
    await page.locator('#require-each').check();

    for (let i = 0; i < 25; i += 1) {
      const value = await secret(page);
      expect(value, 'lower missing').toMatch(/[a-z]/);
      expect(value, 'upper missing').toMatch(/[A-Z]/);
      expect(value, 'digit missing').toMatch(/[0-9]/);
      expect(value, 'symbol missing').toMatch(/[^a-zA-Z0-9]/);
      await page.locator('#regenerate').click();
    }
  });

  test('"Make another" actually makes another', async ({ page }) => {
    await setRange(page, 'length', 32);

    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      seen.add(await secret(page));
      await page.locator('#regenerate').click();
    }

    // 32 characters drawn 25 times: a repeat means the randomness is broken,
    // not that we were unlucky.
    expect(seen.size, 'a password repeated').toBe(25);
  });

  test('turning every class off explains itself instead of making nothing', async ({ page }) => {
    await onlyClasses(page, []);

    await expect(page.locator('#no-classes')).toBeVisible();
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#strength')).toBeHidden();

    // And recovers when a class comes back.
    await page.locator('#use-lower').check();
    await expect(page.locator('#no-classes')).toBeHidden();
    await expect(page.locator('#result')).toBeVisible();
  });

  test('the strength readout is counted, not guessed', async ({ page }) => {
    // Lower-case only, 20 characters, no "one of each" rule: the space is
    // exactly 26^20, so the page should report floor(20 * log2(26)) = 94 bits.
    // A meter that scored the finished string instead of counting the draws
    // could not land on this number.
    await setRange(page, 'length', 20);
    await onlyClasses(page, ['use-lower']);
    await page.locator('#require-each').uncheck();

    await expect(page.locator('#bits')).toHaveText('94');
    await expect(page.locator('#verdict')).not.toBeEmpty();
    await expect(page.locator('#crack')).not.toBeEmpty();
  });

  test('the "one of each" rule costs strength rather than flattering it', async ({ page }) => {
    // The README is explicit that requiring one of each makes the set of
    // possible passwords smaller, and that the page subtracts it rather than
    // quoting N^length. So the same settings must report fewer bits with the
    // rule on than off - never more, and never the same.
    await setRange(page, 'length', 8);
    await onlyClasses(page, ['use-lower', 'use-upper', 'use-digits', 'use-symbols']);

    await page.locator('#require-each').uncheck();
    const free = Number(await page.locator('#bits').textContent());

    await page.locator('#require-each').check();
    const required = Number(await page.locator('#bits').textContent());

    expect(required).toBeLessThan(free);
  });
});

test.describe('password-generator: passphrase mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    // Chosen by its value, not by an id. The two modes were a pair of tab
    // buttons with ids on them and are now radios in a segmented control -
    // the same one click to the visitor, six failures at once here, because
    // every test in this describe goes through this line. A radio named for
    // what it selects survives that kind of reshaping; #tab-passphrase did
    // not.
    // The label, because the radio itself is visually hidden - the segmented
    // control draws the span beside it and Playwright will not click what a
    // visitor cannot see. Selected by the value of the input it contains
    // rather than by its text, which is a different word in fifteen
    // languages.
    await page.locator('label.segment:has(input[name="mode"][value="passphrase"])').click();
    await expect(page.locator('input[name="mode"][value="passphrase"]')).toBeChecked();
    await expect(page.locator('#options-passphrase')).toBeVisible();
    // A space separator throughout: the README warns that four words on the
    // long list carry a hyphen of their own (drop-down, felt-tip, t-shirt,
    // yo-yo), so splitting a hyphen-joined phrase back into words works about
    // 399 times in 400. No word contains a space, so this split is exact.
    await page.locator('#separator').selectOption('space');
  });

  test('the word slider sets the number of words exactly', async ({ page }) => {
    for (const words of [3, 6, 12]) {
      await setRange(page, 'words', words);
      await expect(page.locator('#words-out')).toHaveText(String(words));
      expect((await secret(page)).split(' '), `at ${words} words`).toHaveLength(words);
    }
  });

  test('the words come from the list that was asked for', async ({ page }) => {
    await setRange(page, 'words', 12);

    await page.locator('#list').selectOption('short');
    const short = (await secret(page)).split(' ');
    // The EFF short list is built so no word is longer than eight characters;
    // the long list is not.
    for (const word of short) expect(word.length).toBeLessThanOrEqual(8);
  });

  test('the separator is the one that was chosen', async ({ page }) => {
    await setRange(page, 'words', 4);

    await page.locator('#separator').selectOption('dot');
    expect((await secret(page)).split('.')).toHaveLength(4);

    await page.locator('#separator').selectOption('underscore');
    expect((await secret(page)).split('_')).toHaveLength(4);

    await page.locator('#separator').selectOption('digit');
    // A random digit between each pair of words - three of them for four
    // words, and each one an actual choice rather than a fixed character.
    expect(await secret(page)).toMatch(/^[a-z]+[0-9][a-z]+[0-9][a-z]+[0-9][a-z]+$/);
  });

  test('capitalisation is applied as asked', async ({ page }) => {
    await setRange(page, 'words', 5);

    await page.locator('#capitals').selectOption('title');
    for (const word of (await secret(page)).split(' ')) {
      expect(word[0]).toMatch(/[A-Z]/);
    }

    await page.locator('#capitals').selectOption('upper');
    expect(await secret(page)).toBe((await secret(page)).toUpperCase());

    await page.locator('#capitals').selectOption('lower');
    expect(await secret(page)).toMatch(/^[a-z ]+$/);
  });

  test('an added digit and symbol land on the end', async ({ page }) => {
    await setRange(page, 'words', 4);

    await page.locator('#add-digit').check();
    expect(await secret(page)).toMatch(/[0-9]$/);

    await page.locator('#add-symbol').check();
    // The tail is the digit then the symbol, and the symbol comes from the
    // safe set.
    const value = await secret(page);
    expect(value.slice(-2, -1)).toMatch(/[0-9]/);
    expect(SYMBOL_SETS.safe).toContain(value.slice(-1));
  });

  test('the strength readout counts the words, and decoration adds nothing', async ({ page }) => {
    // Six words from the 7,776-word list is 7776^6, so floor(6 * log2(7776))
    // = 77 bits.
    await setRange(page, 'words', 6);
    await page.locator('#list').selectOption('long');
    await expect(page.locator('#bits')).toHaveText('77');

    // Capitalising every word is a rule an attacker reads off this page, so
    // the README says it multiplies the count by one. The number must not move.
    await page.locator('#capitals').selectOption('title');
    await expect(page.locator('#bits')).toHaveText('77');

    // A random digit between the words is a real choice, so it must.
    await page.locator('#separator').selectOption('digit');
    const withDigits = Number(await page.locator('#bits').textContent());
    expect(withDigits).toBeGreaterThan(77);
  });
});

test.describe('password-generator: batch, and the promise', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('asking for a hundred gives a hundred distinct results', async ({ page }) => {
    await setRange(page, 'length', 24);
    await setRange(page, 'count', 100);

    const results = await allResults(page);
    expect(results).toHaveLength(100);
    expect(new Set(results).size, 'a result repeated within the batch').toBe(100);

    await expect(page.locator('#copy-all')).toBeVisible();
    await expect(page.locator('#download-txt')).toBeVisible();
  });

  test('a single result hides the batch controls', async ({ page }) => {
    await setRange(page, 'count', 1);
    await expect(page.locator('#batch')).toBeHidden();
    await expect(page.locator('#copy-all')).toBeHidden();
    await expect(page.locator('#download-txt')).toBeHidden();
  });

  test('the secret is never sent anywhere', async ({ page }) => {
    // The claim this tool lives on: "there is no code path that could send
    // them anywhere". Watch every request the page makes - including the ad
    // and analytics traffic, which is the only traffic there is - and check
    // that no URL or body carries what was just generated.
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.url()} ${req.postData() ?? ''}`);
    });

    await setRange(page, 'length', 32);
    const values: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      values.push(await secret(page));
      await page.locator('#regenerate').click();
    }
    await quiet(page);

    for (const value of values) {
      const leak = traffic.find((request) => carries(request, value));
      expect(leak, 'a request carried the generated secret').toBeUndefined();
    }
  });

  test('the secret is never stored', async ({ page }) => {
    // No history, no localStorage, no sessionStorage, no cookie - the README
    // is explicit that this is a feature request to keep refusing. Checking
    // that the secret is absent, rather than that storage is empty, keeps
    // this honest about the analytics cookie the site does set.
    await setRange(page, 'length', 32);
    const value = await secret(page);

    const stored = await page.evaluate(() => [
      JSON.stringify(Object.entries(localStorage)),
      JSON.stringify(Object.entries(sessionStorage)),
      document.cookie,
    ].join('\n'));

    expect(
      carries(stored, value),
      'the generated secret was written to storage',
    ).toBe(false);
  });

  test('nothing on the page invites the browser to remember it', async ({ page }) => {
    // An <input> holding the result would be offered back by autofill on the
    // next visit, which is a store by another name. The result lives in an
    // <output>, and these are the settings - none of them a text field.
    await expect(page.locator('#secret')).toHaveJSProperty('tagName', 'OUTPUT');
    await expect(page.locator('input[type="text"], input[type="password"]')).toHaveCount(0);
  });
});
