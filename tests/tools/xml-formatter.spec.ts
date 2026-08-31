import { test, expect, type Page } from '@playwright/test';
import { quiet } from '../../lib/engine';
import { afterSetting, mode, through } from '../../lib/text-panes';

/**
 * Tool-level functional tests for the XML formatter, added by website #296.
 *
 * Two jobs on one page. Laying a document out, which must not change what the
 * document says, and turning it into JSON, which must not invent anything.
 *
 * WHAT IS CHECKED AGAINST WHAT
 *
 * The conversion is compared with a value written out in this file, because
 * XML to JSON is a set of choices - what to do with attributes, with repeated
 * children, with the text beside them - and the tool's own answer is no
 * evidence that it made them consistently. Its choices are the ones its
 * source documents: attributes become `@name`, text beside children becomes
 * `#text`, repeated children become one array, and everything is a string,
 * because `<port>8080</port>` says nothing about whether that is a number and
 * a converter that decided would be inventing information.
 *
 * The formatting is compared with the browser's own DOMParser rather than
 * with expected text. Which column a tag lands in is taste and may change;
 * that the same document came out is the promise. DOMParser is a second
 * implementation of XML that this repository did not write, which is what
 * makes it worth asking.
 */

const URL_PATH = '/xml-formatter/';

/** Pick a direction on the Convert tab, once the select has been filled in. */
async function direction(page: Page, id: string): Promise<void> {
  await expect(page.locator(`#conversion option[value="${id}"]`))
    .toHaveCount(1, { timeout: 20_000 });
  await page.locator('#conversion').selectOption(id);
}

/**
 * The document as the browser reads it: every element's path, in order, with
 * its attributes and its own text.
 *
 * Flattened to strings so two documents can be compared with toEqual and the
 * failure names the element that differs. Whitespace-only text is dropped,
 * which is exactly what laying a document out adds and takes away.
 */
async function shape(page: Page, xml: string): Promise<string[]> {
  return page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.querySelector('parsererror')) return ['UNPARSEABLE'];
    const out: string[] = [];
    const walk = (el: Element, at: string) => {
      const path = `${at}/${el.tagName}`;
      const attrs = Array.from(el.attributes)
        .map((one) => `${one.name}=${one.value}`)
        .sort()
        .join(' ');
      const own = Array.from(el.childNodes)
        .filter((node) => node.nodeType === 3 || node.nodeType === 4)
        .map((node) => node.nodeValue ?? '')
        .join('')
        .trim();
      out.push(`${path} [${attrs}] ${own}`);
      for (const child of Array.from(el.children)) walk(child, path);
    };
    if (doc.documentElement) walk(doc.documentElement, '');
    return out;
  }, xml);
}

const CATALOGUE = [
  '<catalogue count="2" xmlns:x="urn:example">',
  '  <item id="1"><name>Spanner</name><price currency="GBP">4.50</price></item>',
  '  <item id="2"><name>Hammer &amp; nails</name><price currency="GBP">7.00</price></item>',
  '  <note>Prices include VAT</note>',
  '</catalogue>',
].join('\n');

test.describe('xml-formatter: laying a document out', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'format');
  });

  test('the document that comes out is the document that went in',
    async ({ page }) => {
      const laid = await through(page, CATALOGUE.replace(/\n\s*/g, ''));

      // The control first: if DOMParser could not read the fixture, every
      // comparison below would be between two identical error markers.
      const wanted = await shape(page, CATALOGUE);
      expect(wanted[0], 'the fixture itself does not parse').not.toBe('UNPARSEABLE');
      expect(wanted.length).toBeGreaterThan(5);

      expect(await shape(page, laid)).toEqual(wanted);
    });

  test('squeezing it flat takes out only the space that was for reading',
    async ({ page }) => {
      const laid = await through(page, CATALOGUE);
      const flat = await afterSetting(
        page,
        () => page.locator('#style').selectOption('minify'),
      );

      expect(flat.length, 'the flat version is no shorter').toBeLessThan(laid.length);
      expect(flat).not.toMatch(/>\s+</);
      expect(await shape(page, flat), 'squeezing it flat changed the document')
        .toEqual(await shape(page, laid));
    });

  test('the indent changes the layout and not the document', async ({ page }) => {
    const two = await through(page, CATALOGUE.replace(/\n\s*/g, ''));
    const four = await afterSetting(page, () => page.locator('#indent').selectOption('4'));

    expect(four).toMatch(/\n {4}<item/);
    expect(two).toMatch(/\n {2}<item/);
    expect(await shape(page, four)).toEqual(await shape(page, two));
  });

  test('a document it cannot read is refused rather than half-formatted',
    async ({ page }) => {
      // The control on the three above. A tool that echoed its input would
      // pass all of them.
      await page.locator('#clear').click();
      await page.locator('#input').fill('<open><unclosed></open>');

      await expect(
        page.locator('#error'),
        'a broken document produced no complaint',
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#output')).toBeEmpty();
    });
});

test.describe('xml-formatter: turning it into JSON', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await mode(page, 'convert');
    await direction(page, 'xml-json');
  });

  test('attributes, repeated children and text land where the tool says they do',
    async ({ page }) => {
      expect(JSON.parse(await through(page, CATALOGUE))).toEqual({
        catalogue: {
          '@count': '2',
          '@xmlns:x': 'urn:example',
          item: [
            { '@id': '1', name: 'Spanner', price: { '@currency': 'GBP', '#text': '4.50' } },
            { '@id': '2', name: 'Hammer & nails', price: { '@currency': 'GBP', '#text': '7.00' } },
          ],
          note: 'Prices include VAT',
        },
      });
    });

  test('a number in a document stays the text it was', async ({ page }) => {
    // The tool's stated choice, and worth holding: `<port>8080</port>` says
    // nothing about whether that is a number, and a leading zero or a version
    // string is destroyed by deciding it is.
    const out = JSON.parse(await through(page,
      '<config><port>8080</port><version>1.10</version><zip>01234</zip></config>'));

    expect(out.config).toEqual({ port: '8080', version: '1.10', zip: '01234' });
    expect(typeof out.config.port, 'a number was invented').toBe('string');
  });

  test('entities are resolved rather than carried through', async ({ page }) => {
    const out = JSON.parse(await through(page,
      '<t>fish &amp; chips &lt;3 &#233; &#x1F9F0;</t>'));
    expect(out.t).toBe('fish & chips <3 é 🧰');
  });

  test('an empty element is null and not an empty object', async ({ page }) => {
    const out = JSON.parse(await through(page, '<r><a/><b></b><c>x</c></r>'));
    expect(out.r).toEqual({ a: null, b: null, c: 'x' });
  });
});

test.describe('xml-formatter: back the other way', () => {
  test('JSON becomes XML under the root name that was asked for',
    async ({ page }) => {
      await page.goto(URL_PATH);
      await mode(page, 'convert');
      await direction(page, 'json-xml');

      const xml = await through(page, '{"name":"abox","tags":["one","two"]}');
      expect(await shape(page, xml), 'what came back is not XML')
        .not.toEqual(['UNPARSEABLE']);
      expect(xml).toContain('<root>');

      const renamed = await afterSetting(page, async () => {
        await page.locator('#root-name').fill('catalogue');
        await page.locator('#root-name').blur();
      });
      expect(renamed).toContain('<catalogue>');
      expect(renamed).not.toContain('<root>');
    });
});

test.describe('xml-formatter: the promise', () => {
  test('what is pasted in never leaves the page', async ({ page }) => {
    const secret = 'PRIVATE-XML-PAYLOAD-9f3e';
    await page.goto(URL_PATH);
    await mode(page, 'format');

    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    await through(page, `<credentials><token>${secret}</token></credentials>`);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'the document was sent somewhere').not.toContain(secret);
    }
  });
});
