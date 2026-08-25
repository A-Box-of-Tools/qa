import fs from 'node:fs';
import path from 'node:path';
import { discoverTools } from './tools';

/**
 * Which tools have a functional spec and which do not.
 *
 * Lives here rather than inside the test because two things need the answer:
 * tests/coverage.spec.ts, which fails the suite, and the workflow that opens
 * an issue about it. Two copies of this would eventually disagree, and the one
 * that disagreed quietly would be the one nobody was reading.
 */

const SPEC_DIRECTORY = path.join(__dirname, '..', 'tests', 'tools');

/** Pages that are not tools, so a spec visiting one is not an orphan. */
const NOT_TOOLS = new Set(['guides', 'roadmap', 'privacy', 'terms']);

function specFiles(): string[] {
  if (!fs.existsSync(SPEC_DIRECTORY)) return [];
  return fs.readdirSync(SPEC_DIRECTORY).filter((name) => name.endsWith('.spec.ts'));
}

const read = (name: string): string => (
  fs.readFileSync(path.join(SPEC_DIRECTORY, name), 'utf8')
);

/**
 * Every tool, with the specs that visit its page.
 *
 * Worked out by reading which pages each spec navigates to rather than from a
 * list kept by hand: several specs cover more than one tool, and a list would
 * go stale exactly when it mattered. A spec has to name a tool's page to test
 * it at all, so naming it is the signal.
 */
export function coverage(): Map<string, string[]> {
  const specs = specFiles().map((name) => ({ name, source: read(name) }));
  const out = new Map<string, string[]>();

  for (const slug of discoverTools()) {
    out.set(slug, specs
      .filter(({ source }) => source.includes(`'/${slug}/'`) || source.includes(`"/${slug}/"`))
      .map(({ name }) => name));
  }

  return out;
}

/** Tools that ship with no functional spec pointing at them. */
export function uncoveredTools(): string[] {
  return [...coverage()].filter(([, specs]) => specs.length === 0).map(([slug]) => slug);
}

/** Specs that navigate to a page no tool provides any more. */
export function orphanedSpecs(): string[] {
  const slugs = new Set(discoverTools());
  const orphans = new Set<string>();

  for (const name of specFiles()) {
    for (const [, slug] of read(name).matchAll(/['"]\/([a-z0-9-]+)\/['"]/g)) {
      if (!slugs.has(slug) && !NOT_TOOLS.has(slug)) orphans.add(`${name} -> /${slug}/`);
    }
  }

  return [...orphans];
}
