import { test, expect, type Page } from '@playwright/test';

/**
 * Tool-level functional tests for Text & Code.
 *
 * Its README makes the sharpest version of the site's argument: "The things
 * people paste into an online formatter are access tokens, session cookies,
 * customer records and unreleased code, and every one of those sites is a site
 * they have handed them to."
 *
 * So one half of this file checks that what is typed never appears in a
 * request, and the other half checks the arithmetic - formatting, encoding and
 * converting - against values computed here rather than against whatever the
 * page produced. A formatter that silently drops a key, or an encoder that
 * mangles a character outside ASCII, is wrong in a way that is invisible until
 * the output is pasted somewhere that matters.
 */

const URL_PATH = '/text-tools/';

/** Switch to a tab and wait for its panel. */
async function mode(page: Page, name: 'format' | 'convert' | 'encode' | 'diff'): Promise<void> {
  await page.locator(`#tab-${name}`).click();
  await expect(page.locator(`#options-${name}`)).toBeVisible();
}

/** Type into the main box and read the output back. */
async function run(page: Page, text: string): Promise<string> {
  await page.locator('#input').fill(text);
  await expect(page.locator('#output')).not.toBeEmpty({ timeout: 20_000 });
  return (await page.locator('#output').textContent()) ?? '';
}

test.describe('text-tools: laying things out', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'format');
  });

  test('formatted JSON is still the same JSON', async ({ page }) => {
    // The only thing a formatter must never do is change the data. Comparing
    // the parsed result rather than the text is what makes that checkable
    // without asserting a particular layout.
    const source = '{"b":1,"a":[3,2,{"deep":true}],"s":"x","n":null,"f":1.5}';
    await page.locator('#language').selectOption('json');

    const out = await run(page, source);
    expect(JSON.parse(out)).toEqual(JSON.parse(source));
    // And it was actually laid out, not handed back unchanged.
    expect(out).toContain('\n');
  });

  test('two spaces means two spaces, and four means four', async ({ page }) => {
    await page.locator('#language').selectOption('json');

    await page.locator('#indent').selectOption('2');
    const two = await run(page, '{"a":{"b":1}}');
    expect(two.split('\n').find((line) => line.includes('"a"'))).toMatch(/^ {2}"a"/);

    await page.locator('#indent').selectOption('4');
    const four = (await page.locator('#output').textContent()) ?? '';
    expect(four.split('\n').find((line) => line.includes('"a"'))).toMatch(/^ {4}"a"/);
  });

  test('squeezing it flat removes the whitespace and nothing else', async ({ page }) => {
    const source = '{\n  "a": 1,\n  "b": [1, 2, 3]\n}';
    await page.locator('#language').selectOption('json');
    await page.locator('#style').selectOption('minify');

    const out = (await run(page, source)).trim();
    expect(out).not.toContain('\n');
    expect(JSON.parse(out)).toEqual(JSON.parse(source));
  });

  test('sorting the keys sorts the keys and keeps the values', async ({ page }) => {
    await page.locator('#language').selectOption('json');
    await page.locator('#sort-keys').check();

    const out = await run(page, '{"c":3,"a":1,"b":2}');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2, c: 3 });
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"b"')).toBeLessThan(out.indexOf('"c"'));
  });

  test('broken JSON is reported rather than quietly repaired', async ({ page }) => {
    // Silently fixing a trailing comma would hand back something that is not
    // what was pasted, which is worse than saying no.
    await page.locator('#language').selectOption('json');
    await page.locator('#input').fill('{"a": 1,}');

    // The reason goes in the dedicated #error element; #result-note only says
    // "Nothing came out." The claim being tested is the second half of that -
    // that nothing came out, rather than a tidied-up guess at what was meant.
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#error')).not.toBeEmpty();
    await expect(page.locator('#output')).toBeEmpty();
  });
});

test.describe('text-tools: encoding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'encode');
  });

  test('Base64 agrees with Node, including outside ASCII', async ({ page }) => {
    // The character set is where a hand-written encoder goes wrong: a string
    // pushed through charCodeAt rather than UTF-8 produces a plausible,
    // incorrect answer for anything above U+00FF.
    const text = 'héllo — 東京 🧰';
    await page.locator('#codec').selectOption('base64');
    await page.locator('input[name="direction"][value="encode"]').check();

    const out = (await run(page, text)).trim();
    expect(out).toBe(Buffer.from(text, 'utf8').toString('base64'));
  });

  test('Base64 decoded is the text that was encoded', async ({ page }) => {
    const text = 'round trip — 東京';
    await page.locator('#codec').selectOption('base64');
    await page.locator('input[name="direction"][value="decode"]').check();

    const out = await run(page, Buffer.from(text, 'utf8').toString('base64'));
    expect(out.trim()).toBe(text);
  });

  test('base64url uses the URL alphabet', async ({ page }) => {
    // The whole point of the variant: + and / must not appear.
    const text = 'ûÿþý';
    await page.locator('#codec').selectOption('base64url');
    await page.locator('input[name="direction"][value="encode"]').check();

    const out = (await run(page, text)).trim();
    expect(out).not.toMatch(/[+/]/);
    expect(out).toBe(
      Buffer.from(text, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    );
  });

  test('hex agrees with Node', async ({ page }) => {
    const text = 'Hex — 東';
    await page.locator('#codec').selectOption('hex');
    await page.locator('input[name="direction"][value="encode"]').check();

    const out = (await run(page, text)).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    expect(out).toBe(Buffer.from(text, 'utf8').toString('hex'));
  });

  test('HTML escaping covers the characters that matter', async ({ page }) => {
    await page.locator('#codec').selectOption('html');
    await page.locator('input[name="direction"][value="encode"]').check();

    const out = await run(page, '<script>alert("x" & \'y\')</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;');
    expect(out).toContain('&gt;');
    expect(out).toContain('&amp;');
  });
});

test.describe('text-tools: converting', () => {
  test('JSON to YAML and back is the same data', async ({ page }) => {
    // The conversion is only worth anything if it survives the return trip;
    // a lost type - a number becoming a string - would show here and nowhere
    // else.
    await page.goto(URL_PATH);
    await mode(page, 'convert');

    const data = { name: 'Ada', age: 36, tags: ['one', 'two'], ok: true, none: null };

    await page.locator('#conversion').selectOption('json-yaml');
    const yaml = await run(page, JSON.stringify(data));
    expect(yaml.length).toBeGreaterThan(0);

    await page.locator('#conversion').selectOption('yaml-json');
    const back = await run(page, yaml);
    expect(JSON.parse(back)).toEqual(data);
  });
});

test.describe('text-tools: comparing', () => {
  test('a difference is found, and identical text is reported as identical', async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'diff');

    await page.locator('#input').fill('one\ntwo\nthree');
    await page.locator('#input-b').fill('one\ntwo\nTHREE');
    await expect(page.locator('#result-note')).not.toBeEmpty();
    const changed = (await page.locator('#result-note').textContent()) ?? '';

    await page.locator('#input-b').fill('one\ntwo\nthree');
    await expect(page.locator('#result-note')).not.toHaveText(changed);
    await expect(page.locator('#result-note')).toContainText(/identical|same|no difference/i);
  });
});

test.describe('text-tools: the promise', () => {
  test('what is typed never appears in a request', async ({ page }) => {
    // The README's own example of what people paste into an online formatter:
    // access tokens, session cookies, customer records.
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const secret = 'ghp_QAcanary9f3e71dNotForSending';
    await mode(page, 'encode');
    await page.locator('#codec').selectOption('base64');
    await run(page, `{"token":"${secret}"}`);
    await page.waitForLoadState('networkidle');

    const encoded = Buffer.from(`{"token":"${secret}"}`, 'utf8').toString('base64');
    for (const entry of traffic) {
      expect(entry, 'the pasted text was sent').not.toContain(secret);
      expect(entry, 'the encoded form was sent').not.toContain(encoded.slice(0, 40));
    }
  });
});
