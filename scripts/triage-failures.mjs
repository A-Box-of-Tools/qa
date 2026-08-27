/**
 * Turn a merged Playwright JSON report into GitHub issues, and take them away
 * again when the tests pass.
 *
 * The published report is the fast signal and it is enough while somebody is
 * looking at it. An issue is the durable one: it arrives by email, it stays
 * until it is dealt with, and it says how long the thing has been broken.
 * Same reasoning as .github/workflows/coverage.yml, which does this for a
 * different question - so the same manners apply here. Issues are edited
 * rather than duplicated, and closing is done with a comment saying why.
 *
 * ONE ISSUE PER TEST, NOT PER RUN AND NOT PER PROJECT
 *
 * Per run would mean a new issue every morning for the same failure. Per
 * project would file the same defect twice, once for Desktop Chrome and once
 * for Mobile - and a contrast bug is one bug however many viewports see it.
 * So a test is identified by its file and its title, the failing projects are
 * listed in the body, and an issue closes when every project passes it.
 *
 * WHAT IT REFUSES TO DO
 *
 * Close anything it did not personally watch pass. A test missing from the
 * report is not a test that passed - the run may have been partial, a shard
 * may have died - so its issue is left alone. The one exception is a test
 * whose file ran without it: that name is genuinely gone, renamed or deleted,
 * and its issue is closed saying so rather than left to haunt the list.
 *
 * Open a hundred issues when the site is down. Past a threshold the failures
 * are one story, not many, and it files them as one issue instead. This is
 * the difference between a bot people read and a bot people mute.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

const LABEL = 'qa-failure';

/**
 * Past this many failing tests, something systemic is wrong - the site is
 * down, a deploy went sideways, the CSP changed under everything - and the
 * individual issues would all say the same thing.
 */
const TOO_MANY = 12;

const DRY_RUN = process.argv.includes('--dry-run');
const reportPath = process.argv[2];

/** Set by the workflow only when every shard actually finished. */
const CAN_CLOSE = process.env.QA_CAN_CLOSE !== 'no';

const RUN_URL = process.env.QA_RUN_URL ?? '';
const REPORT_URL = process.env.QA_REPORT_URL ?? 'https://a-box-of-tools.github.io/qa/';
const TODAY = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ github */

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

/** Mutations go through here so --dry-run is a single, unmissable gate. */
function mutate(args, description) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${description}`);
    return '';
  }
  const out = gh(args);
  console.log(`  ${description}`);
  return out;
}

/* ------------------------------------------------------------------ report */

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Every test in the report, keyed by file + title path, with the projects
 * that failed it and the projects that ran it at all.
 */
function readReport(path) {
  const report = JSON.parse(fs.readFileSync(path, 'utf8'));
  const tests = new Map();
  /** Files that produced any result, for the renamed-test case below. */
  const filesSeen = new Set();

  const walk = (suites, ancestors) => {
    for (const suite of suites ?? []) {
      // The outermost suite of a file is titled with the file itself; that is
      // already carried separately and would only repeat in every title.
      const title = suite.title && suite.title !== suite.file ? [suite.title] : [];
      const here = [...ancestors, ...title];

      for (const spec of suite.specs ?? []) {
        const file = spec.file ?? suite.file ?? '';
        filesSeen.add(file);

        const name = [...here, spec.title].join(' › ');
        const key = `${file} :: ${name}`;
        const entry = tests.get(key) ?? {
          file,
          name,
          line: spec.line ?? 0,
          failing: [],
          passing: [],
          errors: [],
        };

        for (const perProject of spec.tests ?? []) {
          const project = perProject.projectName ?? 'unknown';
          // 'flaky' means it failed and then passed on retry. That is worth
          // knowing but it is not a broken site, and an issue that closes
          // itself tomorrow teaches people to ignore the ones that do not.
          if (perProject.status === 'unexpected') {
            entry.failing.push(project);
            for (const result of perProject.results ?? []) {
              for (const error of result.errors ?? []) {
                if (error.message) entry.errors.push(stripAnsi(error.message));
              }
            }
          } else if (perProject.status === 'expected' || perProject.status === 'flaky') {
            entry.passing.push(project);
          }
          // 'skipped' counts as neither: a skipped test is not evidence of
          // anything, and must never close an issue.
        }

        tests.set(key, entry);
      }

      walk(suite.suites, here);
    }
  };

  walk(report.suites, []);
  return { tests, filesSeen, stats: report.stats ?? {} };
}

const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

/* ------------------------------------------------------------------ bodies */

const MARKER = 'qa-fingerprint';

function issueBody(entry, print, firstSeen) {
  const excerpt = entry.errors.join('\n\n').trim();
  const clipped = excerpt.length > 2500
    ? `${excerpt.slice(0, 2500)}\n\n… truncated; the full error is in the report.`
    : excerpt;

  return [
    `<!-- ${MARKER}: ${print} -->`,
    `<!-- qa-first-seen: ${firstSeen} -->`,
    '',
    `**\`${entry.file}\`** › ${entry.name}`,
    '',
    `Failing on: ${[...new Set(entry.failing)].map((p) => `**${p}**`).join(', ')}`,
    ...(entry.passing.length
      ? [`Passing on: ${[...new Set(entry.passing)].join(', ')}`]
      : []),
    '',
    '```',
    clipped || '(the report recorded no error text for this failure)',
    '```',
    '',
    `First seen: **${firstSeen}** · last seen: **${TODAY}**`,
    '',
    `[Published report](${REPORT_URL})${RUN_URL ? ` · [the run that found it](${RUN_URL})` : ''}`,
    '',
    '---',
    '',
    'Opened automatically by [`scripts/triage-failures.mjs`]'
      + '(../blob/main/scripts/triage-failures.mjs), from the run that publishes'
      + ' the report. It closes itself once the test passes on every project'
      + ' again — so if you fix this, you do not need to come back here.',
  ].join('\n');
}

const readMarker = (body, name) =>
  (body ?? '').match(new RegExp(`<!--\\s*${name}:\\s*([^\\s]+)\\s*-->`))?.[1] ?? '';

/* -------------------------------------------------------------------- main */

function main() {
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`no report at ${reportPath ?? '(no path given)'}`);
    process.exit(1);
  }

  const { tests, filesSeen, stats } = readReport(reportPath);
  const failing = [...tests.entries()].filter(([, entry]) => entry.failing.length > 0);
  const passing = [...tests.entries()].filter(
    ([, entry]) => entry.failing.length === 0 && entry.passing.length > 0,
  );

  console.log(
    `report: ${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, `
    + `${stats.flaky ?? 0} flaky, ${stats.skipped ?? 0} skipped`,
  );
  console.log(`tests that failed: ${failing.length}; tests that passed: ${passing.length}`);

  // The label has to exist before anything can be filed under it, and this is
  // cheaper than remembering to create it by hand in a fresh checkout.
  mutate(
    ['label', 'create', LABEL, '--description', 'A test the QA suite is failing', '--color', 'B60205', '--force'],
    `ensured the ${LABEL} label exists`,
  );

  // Deliberately not filtered by label server-side. GitHub's label index is
  // not read-after-write consistent: an issue created and labelled seconds
  // ago can come back missing from a --label query while a plain list shows
  // it, and this script filed a duplicate the first time it was tried live.
  // The marker in the body is the identity that matters; the label is for
  // people, and is not trusted to be present or current.
  //
  // Note there is no allowFail here, on purpose. If this read fails the
  // script must die: "I could not list the issues" and "there are no issues"
  // are the same value to the code below, and the second one authorises
  // opening every issue again.
  const open = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', '300',
    '--json', 'number,title,body']))
    .map((issue) => ({
      ...issue,
      print: readMarker(issue.body, MARKER),
      firstSeen: readMarker(issue.body, 'qa-first-seen') || TODAY,
    }))
    .filter((issue) => issue.print);
  console.log(`open issues from this script: ${open.length}`);

  const byPrint = new Map(open.map((i) => [i.print, i]));
  // Title is a second, independent way to recognise our own issue, for the
  // window where a body edit has landed but the fingerprint has not been read
  // back yet. Belt and braces: the cost of a missed match is a duplicate.
  const byTitle = new Map(open.map((i) => [i.title, i]));

  /* --- the site is broadly down: one story, not many ---------------------- */

  if (failing.length > TOO_MANY) {
    const title = 'The QA suite is failing broadly';
    const existing = open.find((issue) => issue.title === title);
    const body = [
      `<!-- ${MARKER}: broad -->`,
      `<!-- qa-first-seen: ${existing?.firstSeen ?? TODAY} -->`,
      '',
      `**${failing.length} tests are failing at once.** Past ${TOO_MANY} this is`
      + ' filed as one issue rather than one per test: that many failures at'
      + ' once is usually a single cause — the site down, a deploy half-done,'
      + ' a CSP that changed under everything — and a hundred issues saying so'
      + ' separately would be worse than this one.',
      '',
      ...failing.slice(0, 40).map(([, entry]) => `- \`${entry.file}\` › ${entry.name}`),
      ...(failing.length > 40 ? ['', `…and ${failing.length - 40} more.`] : []),
      '',
      `First seen: **${existing?.firstSeen ?? TODAY}** · last seen: **${TODAY}**`,
      '',
      `[Published report](${REPORT_URL})${RUN_URL ? ` · [the run](${RUN_URL})` : ''}`,
      '',
      '---',
      '',
      'Opened automatically. It closes itself when the suite is green again.'
      + ' Individual failure issues are left untouched while this is open —'
      + ' nothing can be trusted to be genuinely fixed in this state.',
    ].join('\n');

    fs.writeFileSync('issue-body.md', body);
    if (existing) {
      mutate(['issue', 'edit', String(existing.number), '--body-file', 'issue-body.md'],
        `updated #${existing.number} (${failing.length} failures)`);
    } else {
      mutate(['issue', 'create', '--title', title, '--label', LABEL, '--body-file', 'issue-body.md'],
        `opened the broad-failure issue (${failing.length} failures)`);
    }
    return;
  }

  /* --- open or refresh an issue per failing test -------------------------- */

  for (const [key, entry] of failing) {
    const print = fingerprint(key);
    const title = `QA: ${entry.name}`.slice(0, 250);
    const existing = byPrint.get(print) ?? byTitle.get(title);
    const firstSeen = existing?.firstSeen ?? TODAY;

    fs.writeFileSync('issue-body.md', issueBody(entry, print, firstSeen));

    if (existing) {
      // Edited, not commented on. An edit is silent, so a failure that lasts
      // a fortnight does not send a fortnight of mail; the body still carries
      // the current error and how long it has been going on.
      mutate(['issue', 'edit', String(existing.number), '--body-file', 'issue-body.md'],
        `still failing: #${existing.number} ${entry.name}`);
    } else {
      mutate(['issue', 'create', '--title', title, '--label', LABEL,
        '--body-file', 'issue-body.md'], `opened: ${entry.name}`);
    }
  }

  /* --- close the ones that are better ------------------------------------ */

  const passingPrints = new Set(passing.map(([key]) => fingerprint(key)));
  const allPrints = new Set([...tests.keys()].map((key) => fingerprint(key)));

  for (const issue of open) {
    if (!issue.print || issue.print === 'broad') {
      // The broad issue exists only because there were too many failures to
      // file one by one. It should go the moment that stops being true - not
      // only when the suite is green - or it sits alongside the individual
      // issues describing a state the suite is no longer in, which is how it
      // outlived a run that had four failures and four issues to match.
      if (issue.print === 'broad' && failing.length <= TOO_MANY && CAN_CLOSE) {
        mutate(['issue', 'close', String(issue.number), '--comment',
          failing.length === 0
            ? 'The suite is green again. Closed automatically.'
            : `Down to ${failing.length} failing test(s), which is few enough to file`
              + ' one by one - so they have their own issues now and this one is'
              + ' describing a state the suite is no longer in. Closed automatically.'],
          `closed #${issue.number} (${failing.length} failures; below the threshold)`);
      }
      continue;
    }

    if (passingPrints.has(issue.print)) {
      if (!CAN_CLOSE) {
        console.log(`  would close #${issue.number}, but the run was partial - left open`);
        continue;
      }
      mutate(['issue', 'close', String(issue.number), '--comment',
        `This test passes again on every project, as of ${TODAY}. Closed automatically —`
        + ' if it breaks again a new issue will open rather than this one reappearing.'],
        `closed #${issue.number} (passing again)`);
      continue;
    }

    if (allPrints.has(issue.print)) continue; // still failing; handled above

    // Not in the report at all. Absence is normally not evidence - a partial
    // run looks exactly like this - so there are only two cases where it is
    // safe to conclude the test is genuinely gone rather than unobserved.
    const file = (issue.body.match(/\*\*`([^`]+)`\*\*/) ?? [])[1];

    // One: the file it belonged to ran without it. A rename or a deletion
    // within a spec that is otherwise alive.
    const testGone = file && filesSeen.has(file);

    // Two: the spec file is not in the repository any more. This checkout is
    // the same commit the report was produced from, so a path that does not
    // exist here cannot have been skipped by a dead shard - there is nothing
    // left to run. Without this, deleting a spec strands every issue it ever
    // opened: they cannot fail again, and nothing can ever observe them
    // passing. Seven of them were stranded exactly that way the first time a
    // tool was split into three, which is how this case got written.
    const specGone = file && !filesSeen.has(file) && !fs.existsSync(file);

    if (CAN_CLOSE && (testGone || specGone)) {
      mutate(['issue', 'close', String(issue.number), '--comment',
        specGone
          ? `The spec this was about (\`${file}\`) is no longer in the repository,`
            + ' so this cannot fail again. Closed automatically; if the tool it'
            + ' covered still ships, the coverage guard will say so separately.'
          : 'The test this was about no longer exists under that name — renamed or'
            + ' removed — though its spec file still runs. Closed automatically;'
            + ' reopen it if the rename hid a real problem.'],
        `closed #${issue.number} (${specGone ? 'spec removed' : 'test no longer exists'})`);
    } else {
      console.log(`  #${issue.number} was not in this report at all - left open`);
    }
  }
}

main();
