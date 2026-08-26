import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from './site';

/**
 * The site in its other fourteen languages, read out of the etoolbox
 * checkout the same way lib/tools.ts reads the tool list - so adding a
 * language or translating another tool needs nothing changed here.
 *
 * WHAT IS ACTUALLY SEPARATE PER LANGUAGE
 *
 * More than the words. Each locale keeps its own full copy of a tool's
 * markup at locales/<lang>/tools/<tool>.html, and its own translated URL in
 * locales/<lang>/locale.toml's [slugs] table. That means a change to a
 * tool's body.html reaches English and nothing else, and a page can drift
 * structurally from the English one it was copied from without anything
 * saying so. That is not hypothetical: a fix to the DICOM viewer's tag table
 * landed in English only and had to be applied to fourteen files by hand.
 *
 * Hence this module and the specs that use it.
 *
 * There is no TOML parser here on purpose, the same way lib/csp.ts has none:
 * the site's tables are read for the two or three things a test needs rather
 * than modelled in full.
 */

const LOCALES_DIR = path.join(ETOOLBOX_DIR, 'locales');

/** Every language directory, English excluded - it is the source, not a copy. */
export function locales(): string[] {
  return fs.readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Languages written right to left, which get a different `dir` and layout. */
export function isRtl(locale: string): boolean {
  return ['ar', 'fa', 'he', 'ur'].includes(locale);
}

/**
 * A locale's [slugs] table: English slug to translated slug.
 *
 * The table is keyed by the English slug because that is the name of the
 * thing; a tool missing from it is served at its English URL under the
 * language prefix, which is a translation gap rather than a broken link.
 */
const slugCache = new Map<string, Map<string, string>>();

export function slugMap(locale: string): Map<string, string> {
  // Cached because the specs ask for this once per tool per language - some
  // five hundred times - and the answer cannot change during a run.
  const already = slugCache.get(locale);
  if (already) return already;

  const toml = fs.readFileSync(path.join(LOCALES_DIR, locale, 'locale.toml'), 'utf8');
  const table = toml.match(/\r?\n\[slugs\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/);
  const map = new Map<string, string>();
  if (!table) return map;

  for (const line of table[1].split(/\r?\n/)) {
    const entry = line.match(/^\s*"([^"]+)"\s*=\s*"([^"]+)"/);
    if (entry) map.set(entry[1], entry[2]);
  }
  slugCache.set(locale, map);
  return map;
}

/**
 * The language tag a locale's pages actually declare.
 *
 * Not the directory name: zh-TW's pages say zh-Hant, for the reason its own
 * locale.toml gives. The tag is declared there as `hreflang`, so it is read
 * rather than derived - working it out here would mean re-implementing a
 * mapping the site already states, and then being wrong about it separately.
 */
export function declaredLang(locale: string): string {
  const toml = fs.readFileSync(path.join(LOCALES_DIR, locale, 'locale.toml'), 'utf8');
  return toml.match(/^hreflang\s*=\s*"([^"]+)"/m)?.[1] ?? locale;
}

/** Where a tool's page lives in a given language. English sits at the root. */
export function localeUrl(locale: string, slug: string): string {
  const translated = slugMap(locale).get(slug) ?? slug;
  return `/${locale}/${translated}/`;
}

/** The English markup a locale's copy was made from. */
export function englishBody(slug: string): string {
  return fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools', slug, 'body.html'), 'utf8');
}

const localeBodyPath = (locale: string, slug: string) =>
  path.join(LOCALES_DIR, locale, 'tools', `${slug}.html`);

/** A locale's copy of a tool's markup, or null where it has not been translated. */
export function localeBody(locale: string, slug: string): string | null {
  const file = localeBodyPath(locale, slug);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

/**
 * Every element id in a piece of markup.
 *
 * ids are what the tool's JavaScript binds to, which makes them the part of
 * a translated copy that must not differ. A translator who drops one has not
 * changed a word - they have removed the handle a script reaches for, and
 * the page fails at the moment somebody uses it rather than at build time.
 */
export function idsIn(html: string): string[] {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).sort();
}

/**
 * Every phrase key in a piece of markup.
 *
 * The tool's own sentences live in the page rather than in the script, so a
 * translator can reach them; shared/js/phrases.js looks them up by key. A
 * key that exists in English and not in a translation is a sentence that
 * comes out blank, or in English, in front of someone who chose otherwise.
 */
export function phraseKeysIn(html: string): string[] {
  return [...html.matchAll(/data-phrase="([^"]+)"/g)].map((m) => m[1]).sort();
}

/** What one language is missing, compared with what English has. */
export function missingFrom(english: string[], translated: string[]): string[] {
  const have = new Set(translated);
  return english.filter((item) => !have.has(item));
}
