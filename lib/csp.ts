import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from './site';

/**
 * The external origins config/site.toml's [csp] table allows, read out of
 * that file rather than copied here by hand so this list can never drift
 * from the real policy the way a hand-kept copy would. Not a general TOML
 * parser - just enough to pull the https://... literals out of the [csp]
 * table, which is all every entry in every one of its lists ever is (see
 * the comments in config/site.toml).
 *
 * Used by tests/tool-pages.spec.ts to fail loudly if a page ever contacts a
 * host this policy does not already name - the same class of drift the
 * site's own README warns a missing CSP origin causes ("a tool missing an
 * origin showed a blank ad slot").
 */
export function allowedExternalHosts(): Set<string> {
  const tomlPath = path.join(ETOOLBOX_DIR, 'config', 'site.toml');
  const toml = fs.readFileSync(tomlPath, 'utf8');

  const match = toml.match(/\r?\n\[csp\]\r?\n([\s\S]*?)\r?\n\[/);
  if (!match) {
    throw new Error(`Could not find a [csp] table in ${tomlPath} - has it moved or been renamed?`);
  }

  const hosts = new Set<string>();
  for (const url of match[1].match(/https:\/\/[^"'\s]+/g) ?? []) {
    hosts.add(new URL(url).host.replace(/^\*\./, ''));
  }
  return hosts;
}
