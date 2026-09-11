/**
 * The spec files one CI slice should run, out of .github/shards.json.
 *
 *   node scripts/slice-files.mjs "<project>" <n>/<of>
 *
 * Prints them space-separated on one line, which is exactly what goes after
 * `npx playwright test`. Everything else this file has to say goes to stderr,
 * so the workflow can capture stdout and still read the notes in its log.
 *
 * WHAT HAPPENS TO A FILE THE MAP DOES NOT KNOW
 *
 * It runs. A spec that has just been written is not in a map generated from
 * an earlier run, and a map that quietly dropped it would be the worst thing
 * a CI split could do. So every spec file on disk is placed: mapped files go
 * where the map says, and the rest go on to whichever slice is lightest by
 * the map's own seconds, taken in name order so every slice agrees on who got
 * what. A file in the map that is gone from disk - renamed, deleted - is
 * skipped without comment; the next regeneration forgets it.
 *
 * A slice that ends up with no files at all is an error, not an empty list:
 * `npx playwright test` with no files runs the whole suite, and a slice that
 * silently did that would be the second-worst thing a CI split could do.
 */

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = path.join(here, '..');
const MAP = path.join(ROOT, '.github', 'shards.json');

const [project, part] = process.argv.slice(2);
const match = /^(\d+)\/(\d+)$/.exec(part ?? '');
if (!project || !match) {
  console.error('usage: node scripts/slice-files.mjs "<project>" <n>/<of>');
  process.exit(2);
}
const [n, of] = [Number(match[1]), Number(match[2])];

const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
const plan = map.projects?.[project];
if (!plan) {
  console.error(`no plan for project "${project}" in .github/shards.json`);
  process.exit(1);
}
if (plan.slices !== of) {
  console.error(`the workflow asks for ${of} slices of "${project}" and the map plans ${plan.slices}; `
    + 'change one to match the other');
  process.exit(1);
}
if (n < 1 || n > of) {
  console.error(`slice ${n} of ${of} does not exist`);
  process.exit(1);
}

/** Every spec file on disk, as tests/... with forward slashes. */
const onDisk = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.spec.ts')) {
      onDisk.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
})(path.join(ROOT, 'tests'));
onDisk.sort();

const loads = Array(of).fill(0);
for (const { slice, seconds } of Object.values(plan.files)) loads[slice - 1] += seconds;

// A new file's weight, for placing it: the median mapped file. Several new
// files then spread out rather than all landing on the one slice that was
// lightest when the first of them was placed.
const known = Object.values(plan.files).map((f) => f.seconds).sort((a, b) => a - b);
const nominal = known.length ? known[Math.floor(known.length / 2)] : 0;

const mine = [];
const unmapped = [];
for (const file of onDisk) {
  const planned = plan.files[file];
  let slice;
  if (planned) {
    slice = planned.slice;
  } else {
    slice = loads.indexOf(Math.min(...loads)) + 1;
    loads[slice - 1] += nominal;
    unmapped.push(`${file} -> slice ${slice}`);
  }
  if (slice === n) mine.push(file);
}

if (unmapped.length) {
  console.error(`${unmapped.length} spec file(s) not in .github/shards.json, placed on the lightest slice:`);
  for (const line of unmapped) console.error(`  ${line}`);
  console.error('  (regenerate the map with scripts/plan-shards.mjs when convenient)');
}
if (!mine.length) {
  console.error(`slice ${n}/${of} of "${project}" has no files; refusing to run the whole suite by accident`);
  process.exit(1);
}
console.error(`slice ${n}/${of} of "${project}": ${mine.length} files, ~${Math.round(loads[n - 1])} planned test-seconds`);
process.stdout.write(mine.join(' '));
