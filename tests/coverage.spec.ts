import { test, expect } from '@playwright/test';
import { coverage, orphanedSpecs, uncoveredTools } from '../lib/coverage';

/**
 * The suite taking stock of which tools have a spec, and which specs have a
 * tool - and writing the difference down rather than failing on it.
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
 * write the specific test, and the only reliable way to remember is to be
 * told.
 *
 * WHY THIS WRITES IT DOWN INSTEAD OF GOING RED
 *
 * The first version of this failed, loudly and by name, the moment a tool
 * existed with no functional spec pointing at it, and the mirror case failed
 * when a spec pointed at a tool the site did not ship. Both were the right
 * questions, and both had the same problem: the tool and its spec live in
 * different repositories and cannot land in one change, so one of them is
 * always ahead of the other for a while, and whichever order they landed in,
 * something went red. A tool merged first turned the release red until a spec
 * followed; a spec merged first turned production red - and opened three
 * issues - until the release caught up. Three releases running, the fix was
 * a person noticing and doing the other half by hand, and the exemptions
 * that grew up around it (a website pull request against `dev`, a pull
 * request here) only covered the orders somebody had already been caught by.
 *
 * So now neither direction fails anything. Each run takes stock and records
 * what it found as annotations on these tests - `uncovered` for a tool with
 * no spec, `orphan` for a spec with no tool - and scripts/take-stock.mjs
 * turns the annotations into the durable signal: a notice on the run, and on
 * a production run one issue, "Tools and specs out of step", edited in place
 * as the list changes and closed when it is empty. The promise is no longer
 * "a tool cannot reach production without a spec" - it could not be kept
 * across two repositories without somebody standing in the gap - but "a
 * tool in production without a spec is written down where it will be seen,
 * within the hour, until the spec exists."
 *
 * What still fails here is the structural kind of mistake, the kind that is
 * never a matter of timing: the discovery finding nothing at all, which
 * would make every question above vacuously answered.
 */

test.describe('the suite takes stock of what the site ships', () => {
  test('every tool has a functional spec, or is written down as owed one', async () => {
    const all = coverage();
    // The control. This test reads the filesystem with string matching, and
    // the failure mode of that is finding nothing and reporting a clean bill.
    expect(all.size, 'no tools discovered - has the checkout moved?').toBeGreaterThan(30);

    const uncovered = uncoveredTools();
    if (uncovered.length > 0) {
      test.info().annotations.push({ type: 'uncovered', description: uncovered.join(', ') });
      console.log([
        `${uncovered.length} tool(s) have no functional spec yet: ${uncovered.join(', ')}.`,
        'The generic checks in tests/tool-pages.spec.ts already cover the page',
        'itself - that it renders, boots, and contacts nothing it should not.',
        'What is missing is a test of what the tool actually does, which is the',
        'kind of thing that fails silently when it fails. Write one in',
        "tests/tools/, navigate to '/<slug>/', and this entry goes away.",
      ].join('\n'));
    }
  });

  test('every spec points at a tool the site ships, or is written down as waiting for one', async () => {
    // The other direction. A spec left behind after a tool is retired or
    // renamed would sit there failing for a reason nobody can act on; a spec
    // merged ahead of its tool looks exactly the same for a few days. Both
    // are listed, and the list says how long each has been there.
    const orphans = orphanedSpecs();
    if (orphans.length > 0) {
      test.info().annotations.push({ type: 'orphan', description: orphans.join(', ') });
      console.log(
        `${orphans.length} spec(s) navigate to a page no tool provides: ${orphans.join('; ')}. `
        + 'Either the tool is still on its way - the release will settle it - or it was '
        + 'renamed and left a redirecting stub the spec has been quietly testing.',
      );
    }
  });
});
