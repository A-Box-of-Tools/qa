import { test, expect } from '@playwright/test';
import { orphanedSpecs, uncoveredTools } from '../lib/coverage';

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
 * else, so the message arrives through the machinery already in place: the
 * post-deploy run goes red and the published report says which tool it is.
 *
 * The same answer is used by .github/workflows/coverage.yml, which turns it
 * into a GitHub issue - a report has to be looked at, and an issue arrives.
 * Both read lib/coverage.ts, so they cannot disagree.
 */

test.describe('the suite covers what the site ships', () => {
  test('every tool has a functional spec of its own', async () => {
    const uncovered = uncoveredTools();

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
    // sit there failing for a reason nobody can act on.
    expect(
      orphanedSpecs(),
      'a spec navigates to a page that no tool provides any more',
    ).toEqual([]);
  });
});
