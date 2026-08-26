import { test, expect } from '@playwright/test';
import { discoverTools } from '../../lib/tools';
import {
  englishBody, idsIn, localeBody, locales, missingFrom, phraseKeysIn, slugMap,
} from '../../lib/locales';

/**
 * Every tool, in every language, checked against the English it was copied
 * from.
 *
 * WHY THIS EXISTS
 *
 * A translated page is not a rendering of the English one. It is a separate
 * file - locales/<lang>/tools/<tool>.html - copied once and edited by hand
 * ever since. Nothing downstream compares the two, so a change to a tool's
 * markup lands in English and stays there, and the other fourteen copies go
 * on serving the version they were forked at.
 *
 * That is not a hypothetical. A keyboard fix to the DICOM viewer's tag table
 * reached one page of fifteen, and the only reason it reached the other
 * fourteen is that somebody happened to look. This file is that somebody.
 *
 * WHAT IT COMPARES, AND WHY THOSE THINGS
 *
 * Not the words - the words are the entire point of a translation. What must
 * not differ is everything the machinery reaches for: the ids the tool's
 * JavaScript binds to, and the phrase keys shared/js/phrases.js looks up.
 * Both fail silently and late. A dropped id means a control that does
 * nothing on the day somebody uses it; a dropped phrase key means a sentence
 * that comes out blank, or in English, in front of the person who chose
 * otherwise.
 *
 * These read the checkout rather than the site, so there is no browser here
 * and the whole file costs about a second.
 */

const TOOLS = discoverTools();
const LANGS = locales();

test.describe('every tool exists in every language', () => {
  for (const slug of TOOLS) {
    test(`translated everywhere: ${slug}`, async () => {
      const missing = LANGS.filter((lang) => localeBody(lang, slug) === null);
      expect(
        missing,
        `${slug} has no translated copy in: ${missing.join(', ')} - those languages `
        + 'will serve the English markup, or nothing',
      ).toEqual([]);
    });
  }
});

test.describe('the machinery survives translation', () => {
  for (const slug of TOOLS) {
    for (const lang of LANGS) {
      test(`${lang} · ${slug}`, async () => {
        const translated = localeBody(lang, slug);
        test.skip(translated === null, 'not translated; covered by the test above');

        const english = englishBody(slug);

        // ids first: these are what the tool's own script binds to.
        const missingIds = missingFrom(idsIn(english), idsIn(translated!));
        expect(
          missingIds,
          `${lang}/${slug} is missing ${missingIds.length} element id(s) the English page has: `
          + `${missingIds.join(', ')}. Whatever the script does with those is dead on this page.`,
        ).toEqual([]);

        // Then the sentences the script looks up by key.
        const missingPhrases = missingFrom(phraseKeysIn(english), phraseKeysIn(translated!));
        expect(
          missingPhrases,
          `${lang}/${slug} is missing phrase key(s) English defines: ${missingPhrases.join(', ')}. `
          + 'Each is a sentence that comes out blank or in English.',
        ).toEqual([]);
      });
    }
  }
});

test.describe('the translated URLs', () => {
  // Four languages keep the English slugs - hi, ja, zh and zh-TW at the time
  // of writing - which is a decision about scripts and shareable URLs, not an
  // oversight. So the rule is not "every language translates its slugs"; it
  // is that a language does so consistently. A table covering some tools and
  // not others is drift: a visitor gets translated URLs across most of the
  // site and bare English ones wherever the table ran out.
  for (const lang of LANGS) {
    test(`${lang} translates all its slugs or none of them`, async () => {
      const table = slugMap(lang);
      const translated = TOOLS.filter((slug) => table.has(slug));

      if (translated.length === 0) return; // keeps English slugs by policy

      const untranslated = TOOLS.filter((slug) => !table.has(slug));
      expect(
        untranslated,
        `${lang} translates ${translated.length} of ${TOOLS.length} tool slugs, leaving `
        + `${untranslated.join(', ')} at the English URL. Either the table is incomplete `
        + 'or this language has changed policy.',
      ).toEqual([]);
    });

    test(`${lang} gives no two tools the same URL`, async () => {
      // A collision here means one tool is unreachable in this language, and
      // the build has no reason to notice: both entries are valid on their own.
      const table = slugMap(lang);
      const seen = new Map<string, string>();
      const clashes: string[] = [];

      for (const slug of TOOLS) {
        const url = table.get(slug);
        if (!url) continue;
        const already = seen.get(url);
        if (already) clashes.push(`${already} and ${slug} both map to /${lang}/${url}/`);
        else seen.set(url, slug);
      }

      expect(clashes, clashes.join('; ')).toEqual([]);
    });
  }
});
