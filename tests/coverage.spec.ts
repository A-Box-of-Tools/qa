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
 *
 * A SPEC MAY ARRIVE AFTER ITS TOOL, BUT NOT AFTER THE RELEASE
 *
 * The tool and the spec live in different repositories, so they cannot land in
 * one change. Since the website's suite began reading the tree its preview was
 * built from rather than main (#94), a pull request that adds a tool sees the
 * tool - and this test then failed every such pull request until somebody had
 * merged a spec over here first. Two pull requests in two repositories, in a
 * fixed order, and the first of them red the whole time: that is a check
 * telling an author to do something they cannot do yet.
 *
 * So on a website pull request that is not the release this reports instead of
 * failing. The pull request from `dev` to `main` is the release, and it is NOT
 * relaxed - a tool cannot reach production without a spec, which is the
 * promise this file exists to keep. Nothing else changes: production and
 * scheduled runs are strict, and coverage.yml still opens the issue daily
 * whatever any preview run said.
 *
 * "Not the release" rather than "into dev", which is what this said first. The
 * reason for the allowance is that an author cannot land two repositories in
 * one change, and that is no less true one step further out: website#412 is a
 * translation aimed at the branch of the pull request that adds the tool, so
 * its base is neither `main` nor `dev`, and the first version of this held it
 * to a spec that could not exist yet for a tool that was two merges from a
 * release. A branch is further from production than `dev` is, not nearer.
 *
 * QA_PR_BASE is set by report.yml from the branch the website pull request is
 * against. Empty - a production run, a scheduled run, a run somebody started
 * by hand - is the strict answer, because not knowing is not a reason to
 * excuse anything.
 */

const A_SPEC_MAY_FOLLOW = process.env.QA_PR_BASE !== ''
  && process.env.QA_PR_BASE !== undefined
  && process.env.QA_PR_BASE !== 'main';

/**
 * A SPEC MAY ALSO ARRIVE BEFORE ITS TOOL.
 *
 * The mirror of the allowance above, and the same reason for it: the tool and
 * the spec live in different repositories and cannot land in one change. A
 * pull request here that adds a spec for a tool still on the website's `dev`
 * sees a checkout of `main`, where no such tool exists, and both orphan checks
 * report it as a spec left behind by a retirement that never happened.
 *
 * So on a pull request in THIS repository they report instead of failing.
 * Everywhere else they are strict, which is what keeps them worth having: a
 * spec genuinely left behind after a tool is retired still fails the
 * production run, the scheduled run, and the release preview.
 */
const A_TOOL_MAY_FOLLOW = process.env.QA_SELF_PR === 'yes';

test.describe('the suite covers what the site ships', () => {
  test('every tool has a functional spec of its own', async () => {
    const uncovered = uncoveredTools();

    test.skip(
      A_SPEC_MAY_FOLLOW && uncovered.length > 0,
      [
        `${uncovered.length} tool(s) have no functional spec yet:`,
        `  ${uncovered.join(', ')}`,
        'This pull request is against `dev`, where a tool is allowed to arrive',
        'before the spec that tests it - they live in different repositories and',
        'cannot land in one change. Write it in tests/tools/ before the `dev` ->',
        '`main` pull request, which is the release and is not excused this.',
      ].join('\n'),
    );

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
    const orphans = orphanedSpecs();

    test.skip(
      A_TOOL_MAY_FOLLOW && orphans.length > 0,
      `${orphans.join(', ')} - no tool of that name is in this checkout. On a `
      + 'pull request here that is a spec waiting for a tool still on `dev`, '
      + 'not a spec left behind; the release preview and production are strict.',
    );

    expect(
      orphans,
      'a spec navigates to a page that no tool provides any more',
    ).toEqual([]);
  });
});
