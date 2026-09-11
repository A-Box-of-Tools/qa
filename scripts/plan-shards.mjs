/**
 * Turn a merged Playwright JSON report into .github/shards.json: which spec
 * files each CI slice runs, per project, balanced by how long they took.
 *
 * WHY A MAP, AND NOT --shard
 *
 * `--shard n/m` cuts the test list into equal COUNTS in file order, and a
 * count says nothing about duration. The tool specs sort last and are three
 * times slower per test on WebKit, so the last Safari slices got the heavy
 * tail: measured on one run, 7m14s, 7m18s, 10m45s and 12m00s for four slices
 * of the same project, with the whole workflow waiting on the slowest. The
 * same test-seconds balanced by file would have been under 9 minutes each.
 *
 * Playwright cannot weight shards by duration itself. But it takes a list of
 * files, so the balancing can be done here, once, from measured timings, and
 * the workflow hands each slice its list. This script is the "once".
 *
 * HOW IT BALANCES
 *
 * Longest-processing-time first: files sorted by their measured seconds,
 * heaviest first, each placed on whichever slice is lightest so far. Whole
 * files, because Playwright's own parallelism inside a slice spreads a file's
 * tests across the four workers there, and a file is the unit the workflow
 * can name. LPT is within 4/3 of optimal and, on this suite, within a few
 * percent of it.
 *
 * WHEN TO RUN IT AGAIN
 *
 * When the balance has drifted - a slice consistently minutes behind the
 * others - or when a big spec file lands. Not on every change: a file that
 * is not in the map is placed at run time by scripts/slice-files.mjs, so a
 * new spec runs without anybody touching this. The map is a plan, not a
 * gate.
 *
 *   node scripts/plan-shards.mjs merged.json [--slices "Desktop Safari=6,..."]
 *
 * merged.json is what `playwright merge-reports --reporter json` writes over a
 * run's blob reports; the Report workflow's rerun path shows the download and
 * merge. Retries are counted at full cost, which slightly overweights a flaky
 * file, and that is the right direction to be wrong in.
 */

import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '.github', 'shards.json')
  .replace(/^\\([A-Za-z]:)/, '$1').replace(/^\/([A-Za-z]:)/, '$1');

/** How many slices each project gets. The Safari projects carry three times
 *  the test-seconds of the Chrome ones, so they get three times the slices. */
const DEFAULT_SLICES = {
  'Desktop Chrome': 2,
  'Mobile Chrome': 2,
  'Desktop Safari': 6,
  'Mobile Safari': 6,
};

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: node scripts/plan-shards.mjs <merged.json> [--slices "Project=N,Project=N"]');
  process.exit(2);
}
const slices = { ...DEFAULT_SLICES };
const flag = process.argv.indexOf('--slices');
if (flag !== -1) {
  for (const part of process.argv[flag + 1].split(',')) {
    const [project, n] = part.split('=');
    slices[project.trim()] = Number(n);
  }
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

/** Seconds per file per project, every attempt of every test summed. */
const seconds = {};
(function walk(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const file = `tests/${spec.file ?? suite.file}`;
      for (const test of spec.tests ?? []) {
        const project = test.projectName;
        const ms = (test.results ?? []).reduce((sum, result) => sum + (result.duration || 0), 0);
        ((seconds[project] ??= {})[file] ??= 0);
        seconds[project][file] += ms / 1000;
      }
    }
    walk(suite.suites);
  }
})(report.suites);

// A file that ran under some project but has no tests for this one - the two
// locale specs run on Desktop Chrome alone - is still a file on disk, and
// scripts/slice-files.mjs would otherwise report it as new on every run of
// every other project. Listed at zero seconds, so it lands somewhere quietly.
const everyFile = new Set(Object.values(seconds).flatMap((files) => Object.keys(files)));
for (const files of Object.values(seconds)) {
  for (const file of everyFile) files[file] ??= 0;
}

const plan = {};
for (const [project, files] of Object.entries(seconds)) {
  const n = slices[project];
  if (!n) {
    console.error(`no slice count for project "${project}"; pass --slices "${project}=N"`);
    process.exit(1);
  }
  const loads = Array(n).fill(0);
  const placed = {};
  for (const [file, secs] of Object.entries(files).sort((a, b) => b[1] - a[1])) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += secs;
    placed[file] = { slice: lightest + 1, seconds: Math.round(secs * 10) / 10 };
  }
  plan[project] = {
    slices: n,
    // Sorted by name so the file diffs sensibly between regenerations.
    files: Object.fromEntries(Object.entries(placed).sort(([a], [b]) => a.localeCompare(b))),
    loads: loads.map((s) => Math.round(s)),
  };
  console.error(`${project.padEnd(15)} ${n} slices, test-seconds each: ${loads.map((s) => Math.round(s)).join('  ')}`);
}

const out = {
  '//': 'Which spec files each CI slice runs, balanced by measured duration. '
    + 'Generated by scripts/plan-shards.mjs; read by scripts/slice-files.mjs. '
    + 'A file not listed here is placed at run time, so a new spec needs no edit.',
  measured: {
    from: path.basename(reportPath),
    at: (report.stats?.startTime ?? new Date().toISOString()).slice(0, 10),
  },
  projects: plan,
};
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.error(`wrote ${path.relative(process.cwd(), OUT)}`);
