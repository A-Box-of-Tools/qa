/**
 * Turn a merged Playwright JSON report into "run just these again".
 *
 * WHY THIS EXISTS
 *
 * The suite takes fourteen minutes across twelve runners, and a run that goes
 * red usually goes red on one or two tests. Re-running the other four thousand
 * to watch those two is the difference between investigating a failure and
 * waiting for permission to. This reads what failed and hands it back in the
 * form Playwright already understands.
 *
 * BY TEST ID, NOT BY NAME OR LINE
 *
 * Playwright's own `--last-failed` reads a `.last-run.json` holding test ids,
 * and an id is a hash of the project, the file and the titles - so it survives
 * an edit that moves the test down the file, which a `file:line` filter does
 * not, and it needs none of the escaping a title regexp would. That file is
 * normally written by the run itself, into the output directory, which is no
 * use across twelve runners that have each thrown their machine away. Writing
 * it here from the merged report puts the mechanism back where it belongs.
 *
 * WHAT COUNTS AS FAILED
 *
 * `unexpected` only. A flaky test passed on a retry and a skipped one proved
 * nothing; neither is something to go and look at, and including them would
 * quietly turn "the failures" into "everything that was not perfectly clean".
 *
 * Usage:
 *   node scripts/failed-cases.mjs merged.json [--out .last-run.json]
 *
 * Writes the last-run file, prints a human list on stderr, and prints the
 * distinct failing project names to stdout as JSON - which is what the
 * workflow's matrix reads to skip the projects that had nothing wrong.
 */

import fs from 'node:fs';

const reportPath = process.argv[2];
const outFlag = process.argv.indexOf('--out');
const outPath = outFlag === -1 ? '.last-run.json' : process.argv[outFlag + 1];

if (!reportPath) {
  console.error('usage: node scripts/failed-cases.mjs <merged.json> [--out <file>]');
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

/** Every test the report holds, flattened out of the suite tree. */
function* specs(suites, ancestors = []) {
  for (const suite of suites ?? []) {
    // The outermost suite of a file is titled with the file itself, which is
    // carried separately and would only repeat in every title.
    const title = suite.title && suite.title !== suite.file ? [suite.title] : [];
    const here = [...ancestors, ...title];
    for (const spec of suite.specs ?? []) {
      yield { spec, name: [...here, spec.title].join(' › '), file: spec.file ?? suite.file ?? '' };
    }
    yield* specs(suite.suites, here);
  }
}

const failed = [];
for (const { spec, name, file } of specs(report.suites)) {
  for (const perProject of spec.tests ?? []) {
    if (perProject.status !== 'unexpected') continue;
    // The id is per project already - it is hashed with the project's own id -
    // so one spec that failed on two engines contributes two of them.
    if (spec.id) failed.push({ id: spec.id, project: perProject.projectName ?? 'unknown', name, file });
  }
}

// `status` is what Playwright writes here itself; nothing reads it on the way
// back in, but a file that lies about its own shape is a trap for the next
// person to open it.
fs.writeFileSync(outPath, `${JSON.stringify({
  status: failed.length ? 'failed' : 'passed',
  failedTests: failed.map((one) => one.id),
}, null, 2)}\n`);

const projects = [...new Set(failed.map((one) => one.project))].sort();

for (const one of failed) console.error(`  [${one.project}] ${one.file} › ${one.name}`);
console.error(failed.length
  ? `\n${failed.length} case(s) to re-run, across ${projects.length} project(s).`
  : '\nNothing failed in that report: there is nothing to re-run.');

process.stdout.write(JSON.stringify(projects));
