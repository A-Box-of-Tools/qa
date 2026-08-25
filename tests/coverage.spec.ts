import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { discoverTools } from '../lib/tools';

/**
 * The suite noticing that a tool has appeared and nobody has tested it.
 *
 * Everything else here discovers tools from the etoolbox checkout, so a new
 * one is picked up automatically by the front-page and tool-page checks: it
 * gets a card, a working drop zone, a privacy panel, no console errors, and a
 * guarantee it contacts nothing it should not. That is real coverage and it
 * arrives for free.
 *
 * What does not arrive for free is the part that matters most - whether the
 * tool does what it says. A redactor that leaves the original underneath, a
 * hash that is subtly wrong, a converter that drops half the picture: all of
 * those pass every generic check on this site. Somebody has to sit down and
 * write the specific test, and the only reliable way to remember is to be told.
 *
 * So this fails, loudly and by name, the moment a tool exists with no
 * functional spec pointing at it. It runs in the same suite as everything
 * else, which means the message arrives through the machinery already in
 * place: the post-deploy run goes red and the published report says which tool
 * it is. Nothing has to be watching, and nobody has to remember.
 */

const SPEC_DIRECTORY = path.join(__dirname, 'tools');

/**
 * Which tools each spec covers, worked out from the paths it navigates to.
 *
 * Read from the files rather than kept as a list here, because a list is one
 * more thing to forget: several specs cover more than one tool - gif.spec.ts
 * has the maker, the splitter and the analyzer; video.spec.ts has four - and a
 * hand-written mapping would go stale exactly when it mattered. A tool is
 * counted as covered when a spec names its page, which is what a spec has to
 * do to test it at all.
 */
function coverage(): Map<string, string[]> {
  const found = new Map<string, string[]>();

  const specs = fs.readdirSync(SPEC_DIRECTORY)
    .filter((name) => name.endsWith('.spec.ts'));

  for (const slug of discoverTools()) {
    const covering = specs.filter((name) => {
      const source = fs.readFileSync(path.join(SPEC_DIRECTORY, name), 'utf8');
      return source.includes(`'/${slug}/'`) || source.includes(`"/${slug}/"`);
    });
    found.set(slug, covering);
  }

  return found;
}

test.describe('the suite covers what the site ships', () => {
  test('every tool has a functional spec of its own', async () => {
    const uncovered = [...coverage()]
      .filter(([, specs]) => specs.length === 0)
      .map(([slug]) => slug);

    expect(
      uncovered,
      uncovered.length === 0 ? '' : [
        '',
        `${uncovered.length} tool(s) have no functional spec:`,
        ...uncovered.map((slug) => `  - ${slug}`),
        '',
        'The generic checks in tests/tool-pages.spec.ts already cover the page',
        'itself - that it renders, boots, and contacts nothing it should not.',
        'What is missing is a test of what the tool actually does, which is the',
        'kind of thing that fails silently when it fails.',
        '',
        `Write one in tests/tools/, navigate to '/<slug>/', and this will pass.`,
        'lib/ already has readers and writers for PNG, GIF, PDF, JPEG/EXIF, MP4,',
        'WAV, ICO and HEIC, and browser-side helpers for recording video and',
        'measuring a decoded image - so the fixture is usually already solved.',
        '',
      ].join('\n'),
    ).toEqual([]);
  });

  test('no spec points at a tool that has been removed', async () => {
    // The other direction: a spec left behind after a tool is retired would
    // sit there passing against a page that no longer exists, or failing for a
    // reason nobody can act on.
    const slugs = new Set(discoverTools());
    const orphans: string[] = [];

    for (const name of fs.readdirSync(SPEC_DIRECTORY).filter((f) => f.endsWith('.spec.ts'))) {
      const source = fs.readFileSync(path.join(SPEC_DIRECTORY, name), 'utf8');
      for (const [, slug] of source.matchAll(/['"]\/([a-z0-9-]+)\/['"]/g)) {
        // Only paths that look like a tool page, not '/' or a guide.
        if (!slugs.has(slug) && !['guides', 'roadmap', 'privacy', 'terms'].includes(slug)) {
          orphans.push(`${name} -> /${slug}/`);
        }
      }
    }

    expect(
      [...new Set(orphans)],
      'a spec navigates to a page that no tool provides any more',
    ).toEqual([]);
  });
});
