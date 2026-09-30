import { test, expect } from '@playwright/test';
import { discoverTools, hasFilePicker } from '../../lib/tools';
import {
  absentLocales, declaredLang, isRtl, localeUrl, locales, offeredLocales,
  servedLocales, unadvertisedLocales, maintainedLocales,
} from '../../lib/locales';

/**
 * Every tool page, in every language, fetched from the site as served.
 *
 * The companion file checks that the translated sources still match English.
 * This one checks the other half: that what the build makes of them is
 * actually reachable, and is actually the page it claims to be. Those fail
 * differently. A source can be perfect and the page still 404 because a slug
 * was translated in one table and not another; a page can return 200 and be
 * the English one, which is worse than a 404 because nothing looks wrong.
 *
 * No browser. These are HTTP requests and string checks over the HTML that
 * comes back, which is what makes five hundred of them affordable - a browser
 * pass at this breadth would cost more than the rest of the suite put
 * together, to re-check markup that is already checked from source.
 *
 * Grouped one test per tool rather than one per tool and language. Five
 * hundred test cases would report the same fault fourteen times and make the
 * published report harder to read than the thing it describes; a tool whose
 * Spanish page is missing is one fault, and the message names the language.
 *
 * IN EVERY LANGUAGE THE HOST HAS, WHICH IS NOT ALWAYS FIFTEEN
 *
 * Full previews carry the maintained languages from config/site.toml, while
 * production also carries frozen archive pages. The independent presence
 * gate below requires every maintained hub; discovery then lets these
 * structural checks cover any archived languages the host also provides.
 */

const TOOLS = discoverTools();

test('a full deployment carries every maintained language and its sitemap', async ({ request }) => {
  // Presence is a deployment contract, not something HTTP discovery can
  // infer. Otherwise losing an entire language merely removes its tests.
  const expected = maintainedLocales();
  expect(expected.length, 'no maintained translations were discovered').toBeGreaterThan(0);
  for (const lang of expected) {
    const response = await request.get(`/${lang}/`);
    expect(response.ok(), `the maintained /${lang}/ hub is missing`).toBe(true);
    const opening = (await response.text()).match(/<html\b[^>]*>/i)?.[0] ?? '';
    expect(opening, `/${lang}/ returned a different page or a soft 404`)
      .toMatch(new RegExp(`\\blang=["']${declaredLang(lang)}["']`));
  }
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.ok(), 'the full deployment lost its sitemap').toBe(true);
  expect(await sitemap.text()).toContain('<urlset');
});

test.describe('every tool, in every language, as served', () => {
  for (const slug of TOOLS) {
    test(`every language the site serves: ${slug}`, async ({ request }, testInfo) => {
      test.setTimeout(120_000);
      const faults: string[] = [];

      const here = await servedLocales(request);
      const langs = locales().filter((lang) => here.has(lang));
      // The deployment gate above reports missing maintained languages.
      // These per-tool checks must not report success for an empty set.
      test.skip(langs.length === 0, 'this host carries no translated language at all');
      // Said out loud in the report rather than left to be inferred from a
      // pass. A run that checked three languages and said nothing about the
      // other twelve reads exactly like one that checked all fifteen.
      const absent = await absentLocales(request);
      if (absent.length) {
        testInfo.annotations.push({
          type: 'not on this host',
          description: `${absent.join(', ')} - not built here, so not asked for`,
        });
      }

      for (const lang of langs) {
        const url = localeUrl(lang, slug);

        // Asked twice before a failure is believed. Five hundred requests
        // arriving at one site in under a minute is exactly the shape of
        // traffic a CDN throttles, and a page that was briefly refused is not
        // a page that is missing - the first draft of this file reported
        // redact-image as broken in Italian on one run and fine on the next.
        // A genuine 404 answers the same way both times; a blip does not.
        let response = await request.get(url, { failOnStatusCode: false });
        if (!response.ok()) {
          await new Promise((settle) => { setTimeout(settle, 500); });
          response = await request.get(url, { failOnStatusCode: false });
        }

        if (!response.ok()) {
          faults.push(`${url} returned ${response.status()} twice`);
          continue;
        }

        const html = await response.text();
        const openingTag = html.match(/<html[^>]*>/)?.[0] ?? '';

        // The page must say which language it is in, and say the right one.
        // A locale URL serving a page that declares English is the failure
        // this is really looking for: it returns 200, it looks fine, and the
        // visitor gets the wrong language with no sign anything went wrong.
        const expected = declaredLang(lang);
        if (!new RegExp(`lang="${expected}"`).test(openingTag)) {
          faults.push(`${url} declares ${openingTag.slice(0, 60)} - expected lang="${expected}"`);
        }

        // Right-to-left languages need the direction on the document, not
        // only in the stylesheet: without it the browser lays the text out
        // left to right whatever the CSS says about alignment.
        if (isRtl(lang) && !/dir="rtl"/.test(openingTag)) {
          faults.push(`${url} is right-to-left but the document does not say dir="rtl"`);
        }

        // The controls the tool's own script binds to have to survive into
        // the built page. The source-level check in parity.spec.ts proves the
        // translated markup has them; this proves the build kept them.
        const required = hasFilePicker(slug)
          ? ['id="file-input"', 'id="dropzone"', 'id="privacy-toggle"']
          : ['id="privacy-toggle"'];
        for (const needle of required) {
          if (!html.includes(needle)) faults.push(`${url} is missing ${needle}`);
        }
      }

      expect(faults, `\n${faults.join('\n')}\n`).toEqual([]);
    });
  }
});

test.describe('the language switcher goes where it says', () => {
  // One page is enough to test the switcher itself, but the whole set has to
  // be right in it, and the set has two halves now. A language the site
  // offers and does not link to is one nobody can reach except by typing the
  // URL, which is the same as not shipping it. A language the site has
  // stopped offering and links to anyway is the change half-made: it would
  // still be inviting a crawler into a page that says `noindex`, and still
  // be pointing at a page that does not point back.
  //
  // Which half a language is in is read from the site's own
  // `unadvertised_languages` rather than listed here, so this is right on
  // both sides of that change and needs nothing done to it when the list
  // moves. See offeredLocales() in lib/locales.ts.
  test('every offered language is linked, and no hidden one is', async ({ request }) => {
    test.setTimeout(180_000);
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    const html = await response.text();

    const linked = new Set(
      [...html.matchAll(/hreflang="([^"]+)"/g)].map((m) => m[1]),
    );

    // The deployment gate independently requires maintained languages. Any
    // archived languages absent from this host remain outside this check.
    const here = await servedLocales(request);
    const missing = offeredLocales()
      .filter((lang) => here.has(lang))
      .filter((lang) => !linked.has(declaredLang(lang)));
    expect(
      missing,
      `the front page offers no alternate for: ${missing.join(', ')} - those languages `
      + 'exist but nothing links to them',
    ).toEqual([]);

    const hidden = [...unadvertisedLocales()];
    const leaked = hidden.filter((lang) => linked.has(declaredLang(lang)));
    expect(
      leaked,
      `the front page still points at: ${leaked.join(', ')} - those languages are not `
      + 'offered any more, and a page they do not point back from should not be linked',
    ).toEqual([]);
  });
});
