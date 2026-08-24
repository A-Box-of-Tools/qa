import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from './site';

/**
 * The character sets the password generator's browser tests assert against,
 * read out of the tool's own src/generate.js rather than copied here - the
 * same reason lib/csp.ts parses config/site.toml instead of keeping a second
 * list. Change the safe symbol set over there and these tests follow it; a
 * hand-kept copy would quietly stop testing what the tool actually does.
 *
 * Regexes rather than an import: generate.js is an ES module living outside
 * this project's tsconfig, and these are three string literals. Parsing them
 * is less machinery than making that module loadable from here. Each throws
 * rather than returning a default if the shape changes, so a rename fails
 * loudly instead of silently testing nothing.
 */
function source(): string {
  return fs.readFileSync(
    path.join(ETOOLBOX_DIR, 'tools', 'password-generator', 'src', 'generate.js'),
    'utf8',
  );
}

function extract(label: string, pattern: RegExp): string {
  const match = source().match(pattern);
  if (!match) {
    throw new Error(
      `Could not read ${label} from the password generator's generate.js - has it been renamed or reshaped?`,
    );
  }
  return match[1];
}

/** The two symbol sets, from the SYMBOL_SETS object literal in generate.js. */
export const SYMBOL_SETS = {
  /** Everything except the space, both quotes, the backtick and the backslash. */
  get full(): string {
    return extract('SYMBOL_SETS.full', /\bfull:\s*'([^']*)'/);
  },
  /** The set virtually every site with a symbol rule accepts. */
  get safe(): string {
    return extract('SYMBOL_SETS.safe', /\bsafe:\s*'([^']*)'/);
  },
};

/** The characters dropped when "avoid look-alikes" is on - Il1|O0. */
export const LOOKALIKES: string = extract(
  'LOOKALIKES',
  /\bLOOKALIKES\s*=\s*'([^']*)'/,
);
