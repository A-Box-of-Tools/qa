import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { discoverTools } from '../lib/tools';

/**
 * No tool spec may point at an address the site no longer uses.
 *
 * Most of this suite discovers what it tests - discoverTools() reads the
 * site's own tools/ folder, so a tool added yesterday is walked today without
 * anybody editing a list. The tool-level specs are the exception, and have to
 * be: a file about the JSON formatter names the JSON formatter, and a
 * discovered slug would tell it nothing about what to type into which box.
 *
 * So thirty-nine addresses are written down by hand, in thirty spec files, and
 * website #294 moved three of them - /format-json/ to /json-formatter/,
 * /compare-text/ to /text-diff/, /encode-text/ to /base64/ - for the good
 * reason that the new ones are what people type into a search box.
 *
 * WHY THAT DOES NOT ANNOUNCE ITSELF
 *
 * Because the site is careful. A moved page leaves a stub behind with a meta
 * refresh on it, so `page.goto('/format-json/')` still arrives somewhere - and
 * a spec pointing at the old address goes on passing, quietly testing a
 * redirect, until the day the stub is cleaned up and thirty tests fail at once
 * with a timeout that says nothing about renames.
 *
 * This is one test rather than an edit to thirty files. It reads the path
 * constants back out of the specs and requires each to name a tool that
 * exists, so the next rename fails immediately, in one place, with the old
 * name and the list of real ones in the message.
 */

const SPECS = path.join(__dirname, 'tools');

/** `const URL_PATH = '/resize-image/';` and its thirty-eight siblings. */
const CONSTANT = /^const\s+[A-Z_][A-Z0-9_]*\s*=\s*'\/([a-z0-9-]+)\/';$/gm;

interface Reference {
  file: string;
  slug: string;
}

function referencesInSpecs(): Reference[] {
  const found: Reference[] = [];
  for (const name of fs.readdirSync(SPECS).filter((one) => one.endsWith('.spec.ts'))) {
    const source = fs.readFileSync(path.join(SPECS, name), 'utf8');
    for (const match of source.matchAll(CONSTANT)) {
      found.push({ file: `tests/tools/${name}`, slug: match[1] });
    }
  }
  return found;
}

test.describe('the tool specs point at addresses that exist', () => {
  test('every path constant names a tool the site ships', async () => {
    const shipped = new Set(discoverTools());
    const references = referencesInSpecs();

    // Two controls, because this test reads source with a regular expression
    // and the failure mode of that is finding nothing and saying so cheerfully.
    expect(references.length, 'no path constants found - has the shape changed?')
      .toBeGreaterThan(30);
    expect(shipped.size, 'no tools discovered').toBeGreaterThan(30);

    const stale = references
      .filter((one) => !shipped.has(one.slug))
      .map((one) => `${one.file} points at /${one.slug}/`);

    expect(
      stale,
      `${stale.join('; ')} - no tool of that name is shipped. If it was renamed, `
      + 'the site leaves a redirecting stub behind, so these specs would have '
      + `gone on passing against it. Shipped tools: ${[...shipped].join(', ')}`,
    ).toEqual([]);
  });

  test('every tool with a spec of its own has that spec named after it', async () => {
    // The other half, and the one that keeps the suite legible: a file called
    // format-json.spec.ts that tests /json-formatter/ is worse than either
    // mistake alone, because it would pass.
    const wrong: string[] = [];
    for (const name of fs.readdirSync(SPECS).filter((one) => one.endsWith('.spec.ts'))) {
      const slug = name.replace(/\.spec\.ts$/, '');
      const source = fs.readFileSync(path.join(SPECS, name), 'utf8');
      // Only the files named after a single tool are held to this. audio,
      // gif, video and the rest cover several on purpose, and qr-camera and
      // video-refusal are named for the thing they check rather than a tool.
      if (!discoverTools().includes(slug)) continue;
      if (!source.includes(`'/${slug}/'`)) {
        wrong.push(`${name} is named for /${slug}/ but never mentions it`);
      }
    }

    expect(wrong, wrong.join('; ')).toEqual([]);
  });
});
