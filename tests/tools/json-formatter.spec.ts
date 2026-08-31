import { test, expect } from '@playwright/test';
import { quiet } from '../../lib/engine';
import { afterSetting, mode, through } from '../../lib/text-panes';

/**
 * Tool-level functional tests for the formatter.
 *
 * This is one of the three tools the old Text & Code page became, and it
 * inherits that page's argument: "The things people paste into an online
 * formatter are access tokens, session cookies, customer records and
 * unreleased code, and every one of those sites is a site they have handed
 * them to." So the promise is tested here as well as the arithmetic.
 *
 * The arithmetic is checked against values computed in this file rather than
 * against whatever the page produced. A formatter that silently drops a key,
 * or a converter that turns a number into a string, is wrong in a way that
 * stays invisible until the output is pasted somewhere it matters - which is
 * exactly the moment nobody is checking.
 *
 * The layout itself is deliberately under-asserted. Which column a bracket
 * lands in is a matter of taste and may change; that the data survived is
 * not, so the tests parse the output and compare data, and only check the
 * text where the setting under test is about the text.
 */

const URL_PATH = '/json-formatter/';

test.describe('json-formatter: laying things out', () => {
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

    const out = await through(page, source);
    expect(JSON.parse(out)).toEqual(JSON.parse(source));
    // And it was actually laid out, not handed back unchanged.
    expect(out).toContain('\n');
  });

  test('two spaces means two spaces, four means four, and a tab is a tab', async ({ page }) => {
    await page.locator('#language').selectOption('json');

    await page.locator('#indent').selectOption('2');
    const two = await through(page, '{"a":{"b":1}}');
    expect(two.split('\n').find((line) => line.includes('"a"'))).toMatch(/^ {2}"a"/);

    const four = await afterSetting(page, () => page.locator('#indent').selectOption('4'));
    expect(four.split('\n').find((line) => line.includes('"a"'))).toMatch(/^ {4}"a"/);

    // The tab setting is the one that cannot be checked by counting spaces,
    // and the one most likely to be quietly implemented as spaces anyway.
    const tabbed = await afterSetting(page, () => page.locator('#indent').selectOption('tab'));
    expect(tabbed.split('\n').find((line) => line.includes('"a"'))).toMatch(/^\t"a"/);
  });

  test('squeezing it flat removes the whitespace and nothing else', async ({ page }) => {
    const source = '{\n  "a": 1,\n  "b": [1, 2, 3]\n}';
    await page.locator('#language').selectOption('json');
    await page.locator('#style').selectOption('minify');

    const out = (await through(page, source)).trim();
    expect(out).not.toContain('\n');
    expect(JSON.parse(out)).toEqual(JSON.parse(source));
  });

  test('sorting the keys sorts the keys and keeps the values', async ({ page }) => {
    await page.locator('#language').selectOption('json');
    await page.locator('#sort-keys').check();

    const out = await through(page, '{"c":3,"a":1,"b":2}');
    expect(JSON.parse(out)).toEqual({ a: 1, b: 2, c: 3 });
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"b"')).toBeLessThan(out.indexOf('"c"'));
  });

  test('numbers survive being laid out', async ({ page }) => {
    // The failure this is looking for is a formatter that round-trips values
    // through a float: an id like 9007199254740993 comes back one lower and
    // nothing on screen says so. Compared as text, because comparing it as a
    // number is the very mistake being tested for.
    await page.locator('#language').selectOption('json');

    const out = await through(page, '{"id":9007199254740993,"small":1e-7,"neg":-0.0}');
    expect(out).toContain('9007199254740993');
  });

  test('broken JSON is reported rather than quietly repaired', async ({ page }) => {
    // Silently fixing a trailing comma would hand back something that is not
    // what was pasted, which is worse than saying no.
    await page.locator('#language').selectOption('json');
    await page.locator('#input').fill('{"a": 1,}');

    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#error')).not.toBeEmpty();
    await expect(page.locator('#output')).toBeEmpty();
  });
});

test.describe('json-formatter: the other languages', () => {
  // The tool is named for JSON and handles five languages. The four that are
  // not JSON had no coverage at all when this page was split out of Text &
  // Code, which makes them exactly where a regression would go unnoticed.
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'format');
  });

  test('XML is laid out and keeps its content', async ({ page }) => {
    await page.locator('#language').selectOption('xml');

    const out = await through(page, '<a><b attr="1">text</b><c/></a>');
    expect(out).toContain('\n');
    expect(out).toContain('<b');
    expect(out).toContain('text');
    expect(out).toContain('attr="1"');
  });

  test('CSS is laid out and keeps its declarations', async ({ page }) => {
    await page.locator('#language').selectOption('css');

    const out = await through(page, 'a{color:red;background:blue}b{margin:0}');
    expect(out).toContain('\n');
    expect(out).toContain('color');
    expect(out).toContain('red');
    expect(out).toContain('margin');
  });

  test('the language is worked out from the text when it is not stated', async ({ page }) => {
    // 'auto' is the default, so this is the path almost everybody takes and
    // the one where being wrong is least visible.
    await page.locator('#language').selectOption('auto');

    await through(page, '{"clearly":"json"}');
    await expect(page.locator('#detected')).toContainText(/json/i);
  });
});

test.describe('json-formatter: converting', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'convert');
  });

  test('JSON to YAML and back is the same data', async ({ page }) => {
    // The conversion is only worth anything if it survives the return trip;
    // a lost type - a number becoming a string - would show here and nowhere
    // else.
    const data = { name: 'Ada', age: 36, tags: ['one', 'two'], ok: true, none: null };

    await page.locator('#conversion').selectOption('json-yaml');
    const yaml = await through(page, JSON.stringify(data));
    expect(yaml.length).toBeGreaterThan(0);

    await page.locator('#conversion').selectOption('yaml-json');
    const back = await through(page, yaml);
    expect(JSON.parse(back)).toEqual(data);
  });

  test('JSON to XML and back keeps the values', async ({ page }) => {
    // XML has one element at the top and JSON does not, so the tool invents
    // one - which means the return trip is not expected to be identical, and
    // the honest assertion is about the values rather than the shape.
    const data = { name: 'Ada', city: 'Cairo' };

    await page.locator('#conversion').selectOption('json-xml');
    const xml = await through(page, JSON.stringify(data));
    expect(xml).toContain('Ada');
    expect(xml).toContain('Cairo');

    await page.locator('#conversion').selectOption('xml-json');
    const back = await through(page, xml);
    expect(back).toContain('Ada');
    expect(back).toContain('Cairo');
    // Whatever it wrapped it in, it must still be JSON.
    expect(() => JSON.parse(back)).not.toThrow();
  });
});

test.describe('json-formatter: the promise', () => {
  test('what is typed never appears in a request', async ({ page }) => {
    // The tool's own example of what people paste into an online formatter:
    // access tokens, session cookies, customer records.
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const secret = 'ghp_QAcanary9f3e71dNotForSending';
    await mode(page, 'format');
    await page.locator('#language').selectOption('json');
    await through(page, `{"token":"${secret}"}`);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the pasted text was sent').not.toContain(secret);
    }
  });
});
