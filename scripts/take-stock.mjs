/**
 * Turn a run's stock-taking into the durable signal: a notice on the run, and
 * on production one issue that says which tools and specs are out of step.
 *
 * tests/coverage.spec.ts and tests/tool-paths.spec.ts no longer fail when a
 * tool has no spec or a spec has no tool - see the header of the first for
 * why: the two live in different repositories, one is always ahead of the
 * other for a while, and a red run in either direction only ever asked a
 * person to do by hand the half that could not land yet. Instead they record
 * what they found as annotations, and this reads the annotations out of the
 * JSON report and does two things with them.
 *
 * ON EVERY RUN: a `::notice` per finding and a section in the step summary,
 * so an author whose pull request adds a tool is told, on that run, that a
 * spec is owed - without the run going red for something they cannot fix
 * from that repository.
 *
 * ON A PRODUCTION RUN (QA_STOCK_ISSUE=yes): one issue, "Tools and specs out
 * of step", opened when the list is not empty, edited in place as it changes
 * - so a month of the same finding is one issue and no mail - and closed
 * with a comment when it is empty again. The same manners as
 * scripts/triage-failures.mjs, and one issue rather than one per finding,
 * because a tool waiting for its spec and a spec waiting for its tool are
 * usually the same release seen from two sides.
 *
 * The same script serves .github/workflows/coverage.yml, which runs the two
 * specs on their own against the website's main once a day, for the days
 * when nothing deploys and nothing else would look.
 *
 *   node scripts/take-stock.mjs <report.json> [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const TITLE = 'Tools and specs out of step';
/** What .github/workflows/coverage.yml called its issue before this script. */
const OLD_TITLE = 'Tools without functional specs';
const MARKER = 'qa-stock';
const LABEL = 'qa-coverage';

const DRY_RUN = process.argv.includes('--dry-run');
const MANAGE_ISSUE = process.env.QA_STOCK_ISSUE === 'yes';
const RUN_URL = process.env.QA_RUN_URL ?? '';
const TODAY = new Date().toISOString().slice(0, 10);

const reportPath = process.argv[2];
if (!reportPath || !fs.existsSync(reportPath)) {
  console.error(`no report at ${reportPath ?? '(no path given)'}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ report */

/**
 * The two kinds of finding, each a set of names: the same tool is found by
 * every project that ran the test, and a spec with no tool is found both by
 * the orphan check and by the path-constant one, and once is enough.
 */
const KINDS = {
  uncovered: {
    heading: 'Tools with no functional spec',
    explain: 'Shipped, and covered only by the generic page checks. Each needs a spec in '
      + "`tests/tools/` that navigates to `'/<slug>/'` and tests what the tool does.",
    notice: (name) => `${name} ships with no functional spec yet - the generic page checks `
      + 'cover it; a spec in tests/tools/ is owed.',
  },
  orphan: {
    heading: 'Specs pointing at a page no tool provides',
    explain: 'Either the tool is still on its way and the release will settle it, or it '
      + 'was renamed or retired and the spec has been testing a redirecting stub.',
    notice: (name) => `${name} - no tool of that name is shipped here.`,
  },
};

function findings(path) {
  const report = JSON.parse(fs.readFileSync(path, 'utf8'));
  const found = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, new Set()]));

  const walk = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const perProject of spec.tests ?? []) {
          for (const note of perProject.annotations ?? []) {
            if (!(note.type in found) || !note.description) continue;
            for (const name of note.description.split(',')) {
              if (name.trim()) found[note.type].add(name.trim());
            }
          }
        }
      }
      walk(suite.suites);
    }
  };
  walk(report.suites);
  return found;
}

/* ------------------------------------------------------------------ github */

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function mutate(args, description) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${description}`);
    return '';
  }
  const out = gh(args);
  console.log(`  ${description}`);
  return out;
}

const readMarker = (body, name) =>
  (body ?? '').match(new RegExp(`<!--\\s*${name}:\\s*([^\\s]+)\\s*-->`))?.[1] ?? '';

function issueBody(found, firstSeen) {
  const sections = [];
  for (const [kind, names] of Object.entries(found)) {
    if (names.size === 0) continue;
    sections.push(
      `### ${KINDS[kind].heading}`,
      '',
      ...[...names].sort().map((name) => `- \`${name}\``),
      '',
      KINDS[kind].explain,
      '',
    );
  }
  return [
    `<!-- ${MARKER}: stock -->`,
    `<!-- qa-first-seen: ${firstSeen} -->`,
    '',
    'The QA suite has taken stock of the site it tests and found the tools and',
    'their specs out of step. Nothing here is a failing test: the tool and its',
    'spec live in different repositories and cannot land in one change, so one',
    'of them is often ahead of the other for a few days. This issue is where',
    'that is written down until it is settled.',
    '',
    ...sections,
    `First seen: **${firstSeen}** · last seen: **${TODAY}**`,
    RUN_URL ? `\n[The run that took stock](${RUN_URL})` : '',
    '',
    '---',
    '',
    'Opened automatically by [`scripts/take-stock.mjs`]'
      + '(../blob/main/scripts/take-stock.mjs), from every production run and'
      + ' once a day besides. It is edited in place as the list changes and'
      + ' closes itself when every tool has a spec and every spec has a tool.',
  ].join('\n');
}

/* -------------------------------------------------------------------- main */

function main() {
  const found = findings(reportPath);
  const total = Object.values(found).reduce((n, names) => n + names.size, 0);

  // The notices: on the run, for whoever is looking at it.
  for (const [kind, names] of Object.entries(found)) {
    for (const name of [...names].sort()) console.log(`::notice::${KINDS[kind].notice(name)}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['### Tools and specs', ''];
    if (total === 0) {
      lines.push('Every tool has a functional spec and every spec points at a tool.');
    } else {
      for (const [kind, names] of Object.entries(found)) {
        if (names.size === 0) continue;
        lines.push(`**${KINDS[kind].heading}**`, '',
          ...[...names].sort().map((name) => `- \`${name}\``), '');
      }
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }

  console.log(total === 0
    ? 'tools and specs are in step'
    : `${total} finding(s): ${Object.entries(found)
      .filter(([, names]) => names.size)
      .map(([kind, names]) => `${names.size} ${kind}`).join(', ')}`);

  if (!MANAGE_ISSUE) {
    console.log('not a production run, so the issue is left to one that is');
    return;
  }

  mutate(['label', 'create', LABEL, '--description',
    'A tool with no spec, or a spec with no tool', '--color', 'FBCA04', '--force'],
  `ensured the ${LABEL} label exists`);

  // Recognised by the marker in the body, by the current title, and by the
  // title coverage.yml used before this script, so that one is taken over
  // rather than left open beside its replacement.
  const open = JSON.parse(gh(['issue', 'list', '--state', 'open', '--limit', '300',
    '--json', 'number,title,body']));
  const existing = open.find((issue) => readMarker(issue.body, MARKER) === 'stock')
    ?? open.find((issue) => issue.title === TITLE)
    ?? open.find((issue) => issue.title === OLD_TITLE);
  const firstSeen = readMarker(existing?.body, 'qa-first-seen') || TODAY;

  if (total > 0) {
    fs.writeFileSync('stock-body.md', issueBody(found, firstSeen));
    if (existing) {
      mutate(['issue', 'edit', String(existing.number), '--title', TITLE, '--body-file',
        'stock-body.md', '--add-label', LABEL], `updated #${existing.number}`);
    } else {
      mutate(['issue', 'create', '--title', TITLE, '--label', LABEL, '--body-file',
        'stock-body.md'], 'opened the issue');
    }
    return;
  }

  if (existing) {
    mutate(['issue', 'close', String(existing.number), '--comment',
      `Every tool has a functional spec and every spec points at a tool, as of ${TODAY}. `
      + 'Closed automatically.'], `closed #${existing.number}`);
  } else {
    console.log('nothing to report and no issue open');
  }
}

main();
