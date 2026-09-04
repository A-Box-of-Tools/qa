import fs from 'node:fs';
import path from 'node:path';

/**
 * The etoolbox checkout this suite drives a browser against. Defaults to the
 * sibling directory the two projects normally sit in side by side
 * (…/etoolbox-qa and …/etoolbox under the same parent); override with
 * ETOOLBOX_DIR if your checkout lives somewhere else.
 */
export const ETOOLBOX_DIR = process.env.ETOOLBOX_DIR
  ? path.resolve(process.env.ETOOLBOX_DIR)
  : path.resolve(__dirname, '..', '..', 'etoolbox');

export const PORT = Number(process.env.PORT) || 8080;

/**
 * Where the tests point their browser.
 *
 * Left unset, playwright.config.ts builds and serves ETOOLBOX_DIR itself
 * (via its own serve.ps1) and points here. Set BASE_URL to test a server you
 * already started, or the live site, instead - doing so also switches off
 * this suite's own webServer, so it never launches a second build:
 *
 *   BASE_URL=https://abox.tools/ npx playwright test
 */
export const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

/**
 * Is the suite pointed at the site's own domain, the one config/site.toml
 * calls `domain`? Anywhere else - a pull request's preview on Cloudflare
 * Pages, a build served from a laptop - is the same bytes on a different
 * origin, and a few things on the site know the difference: the analytics
 * switch themselves off there, and the rendezvous admits only the origins it
 * has been told about. A test of those behaviours has to know which side it
 * is on.
 */
export function onProductionDomain(): boolean {
  const toml = fs.readFileSync(path.join(ETOOLBOX_DIR, 'config', 'site.toml'), 'utf8');
  const domain = toml.match(/^domain\s*=\s*"([^"]+)"/m)?.[1];
  if (!domain) throw new Error('config/site.toml has no domain');
  return new URL(BASE_URL).origin === new URL(domain).origin;
}
