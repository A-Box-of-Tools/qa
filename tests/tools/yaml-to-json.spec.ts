import { test, expect } from '@playwright/test';
import { quiet } from '../../lib/engine';
import { afterSetting, through } from '../../lib/text-panes';

/**
 * Tool-level functional tests for the YAML converter.
 *
 * Website #296 gave YAML an address of its own. It is the third tool on this
 * site to convert one text format into another, and the one with the most
 * room to be quietly wrong: YAML is a large grammar with several ways of
 * writing the same thing and one famous way of writing something else by
 * accident. A converter that turns `no` into the boolean false, or the
 * version string 1.10 into the number 1.1, or a Norwegian country code into
 * `false`, is wrong in a way nobody notices until the JSON reaches whatever
 * was going to read it.
 *
 * So every expectation here is a value written out in this file and compared
 * with `JSON.parse` of what the page produced. Not the page's own idea of
 * what it did, and not a string comparison either - the layout of the JSON is
 * the tool's business and may change; the data is the promise.
 *
 * The other direction has no such oracle: Node has no YAML parser, and
 * bringing one in to check a converter would mean trusting a second
 * implementation of the ambiguous half. So JSON to YAML is checked by sending
 * the result back through the tool the other way, which catches anything that
 * loses or changes data - and, separately, by requiring the YAML to look like
 * YAML rather than like JSON with the braces removed.
 */

const URL_PATH = '/yaml-to-json/';

/** Pick a direction, once the select has been filled in by script. */
async function direction(page: import('@playwright/test').Page, id: string): Promise<void> {
  await expect(page.locator(`#conversion option[value="${id}"]`))
    .toHaveCount(1, { timeout: 20_000 });
  await page.locator('#conversion').selectOption(id);
}

test.describe('yaml-to-json: the values that survive the trip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await direction(page, 'yaml-json');
  });

  test('a document of ordinary things arrives with its types intact', async ({ page }) => {
    const yaml = [
      'name: abox',
      'count: 3',
      'ratio: 0.5',
      'ready: true',
      'missing: null',
      'tags:',
      '  - one',
      '  - two',
      'nested:',
      '  deep:',
      '    key: value',
    ].join('\n');

    expect(JSON.parse(await through(page, yaml))).toEqual({
      name: 'abox',
      count: 3,
      ratio: 0.5,
      ready: true,
      missing: null,
      tags: ['one', 'two'],
      nested: { deep: { key: 'value' } },
    });
  });

  test('the strings that look like something else stay strings', async ({ page }) => {
    // The Norway problem and its relatives. Every one of these is a string in
    // the document somebody wrote, and every one of them has been turned into
    // something else by a converter that guessed.
    const yaml = [
      'country: "NO"',
      'version: "1.10"',
      'zip: "01234"',
      'time: "12:30"',
      'yes_but_quoted: "yes"',
    ].join('\n');

    const out = JSON.parse(await through(page, yaml));
    expect(out).toEqual({
      country: 'NO',
      version: '1.10',
      zip: '01234',
      time: '12:30',
      yes_but_quoted: 'yes',
    });
    // Said explicitly, because toEqual on a string and a number of the same
    // printed shape is the one comparison that would not catch this.
    expect(typeof out.version, 'the version number was read as a number').toBe('string');
    expect(typeof out.zip, 'the leading zero was lost').toBe('string');
  });

  test('text above the basic plane is not mangled on the way through',
    async ({ page }) => {
      // Same argument as the encoder's tests: a converter that reads bytes
      // where it should read characters is plausible and wrong.
      const yaml = 'note: "héllo — 東京 🧰"';
      expect(JSON.parse(await through(page, yaml)).note).toBe('héllo — 東京 🧰');
    });

  test('a document it cannot read is refused, and says where', async ({ page }) => {
    // The control on all of the above: a tool that accepted anything and
    // produced something would pass every test in this file.
    await page.locator('#clear').click();
    await page.locator('#input').fill('a:\n  - one\n b: broken indentation\n');

    await expect(
      page.locator('#error'),
      'a malformed document produced no complaint',
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#output')).toBeEmpty();
  });
});

test.describe('yaml-to-json: the settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await direction(page, 'yaml-json');
  });

  test('the indent changes the layout and not the data', async ({ page }) => {
    const yaml = 'outer:\n  inner: 1\n';
    const two = await through(page, yaml);
    const four = await afterSetting(page, () => page.locator('#indent').selectOption('4'));

    expect(four).toContain('    "inner"');
    expect(two).toContain('  "inner"');
    expect(JSON.parse(four), 'changing the indent changed the data')
      .toEqual(JSON.parse(two));
  });

  test('sorting the keys reorders them and keeps every one', async ({ page }) => {
    const yaml = 'zebra: 1\nalpha: 2\nmiddle: 3\n';
    const asWritten = await through(page, yaml);
    expect(Object.keys(JSON.parse(asWritten))).toEqual(['zebra', 'alpha', 'middle']);

    const sorted = await afterSetting(page, () => page.locator('#sort-keys').check());
    expect(Object.keys(JSON.parse(sorted))).toEqual(['alpha', 'middle', 'zebra']);
    expect(JSON.parse(sorted), 'sorting lost or changed a value')
      .toEqual(JSON.parse(asWritten));
  });
});

test.describe('yaml-to-json: the other direction', () => {
  test('JSON comes back as YAML, and that YAML converts back to the same JSON',
    async ({ page }) => {
      // No YAML parser in Node, so the check is a round trip through the tool
      // itself - which cannot prove the YAML is idiomatic, but does catch the
      // failure that matters: a value lost or changed on the way out.
      await page.goto(URL_PATH);
      const source = {
        name: 'abox', count: 3, ready: false, tags: ['one', 'two'],
        nested: { deep: 'value' },
      };

      await direction(page, 'json-yaml');
      const yaml = await through(page, JSON.stringify(source));

      // It has to be YAML rather than the JSON it was handed. Both are legal
      // YAML, so a converter that returned its input unchanged would satisfy
      // the round trip below perfectly.
      expect(yaml, 'the answer is still JSON').not.toContain('{');
      expect(yaml).toMatch(/^name: abox$/m);

      await direction(page, 'yaml-json');
      expect(JSON.parse(await through(page, yaml))).toEqual(source);
    });
});

test.describe('yaml-to-json: the promise', () => {
  test('what is pasted in never leaves the page', async ({ page }) => {
    // The claim this tool exists to make. Config files are the thing people
    // paste into an online converter, and a config file is passwords,
    // hostnames and keys.
    const secret = 'PRIVATE-YAML-PAYLOAD-9f3e';
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await through(page, `token: ${secret}\n`);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the document was sent somewhere').not.toContain(secret);
    }
  });
});
