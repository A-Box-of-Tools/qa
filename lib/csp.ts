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

/**
 * Hosts that legitimately show up in production but that config/site.toml's
 * [csp] table was never going to name, each for its own reason - found by
 * actually running this suite's CSP guard (tests/tool-pages.spec.ts) against
 * the live site rather than a local build, where neither ever appears:
 * AdSense doesn't serve real ads to localhost, and there's no Cloudflare in
 * front of a dev server.
 *
 * - static.cloudflareinsights.com: GitHub Pages sits behind Cloudflare (see
 *   docs/deploying.md), and Cloudflare injects its own analytics beacon
 *   script into the served HTML at the edge - after the origin's own CSP was
 *   already decided, and outside site.toml's control entirely.
 * - csp.withgoogle.com: an ad-quality frame reporting its own internal CSP
 *   violation back to Google - telemetry about Google's ad code, not this
 *   site's, and not something a request from within that frame answers to
 *   this page's CSP for regardless (see the main-frame-only filter in
 *   tests/tool-pages.spec.ts).
 * - a www.google.<cctld> variant of www.google.com: site.toml's own comment
 *   on its [csp] table documents this exact gap - the ads conversion ping
 *   goes to the visitor's country domain, which cannot be named in a CSP
 *   without a wildcard on the TLD, and widening to that is a trade the site
 *   has deliberately declined to make.
 */
export function isKnownBenignHost(host: string): boolean {
  if (host === 'static.cloudflareinsights.com') return true;
  if (host === 'csp.withgoogle.com') return true;
  if (/^www\.google\.[a-z.]+$/.test(host)) return true;
  return false;
}
