import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, ETOOLBOX_DIR } from './site';

/** Resolve the checked-out site's endpoint without executing its source in Node. */
export function rendezvousFromSource(source: string, shared: string | null, href: string): string {
  // A production checkout can predate the shared environment selector even
  // while this QA checkout is testing a newer preview in another run.
  const literal = source.match(/(?:^const RENDEZVOUS\s*=\s*|\borigin\s*=\s*)['"](wss:\/\/[^'"]+)['"]/m)?.[1];
  if (literal) return literal;
  if (!/\brendezvousEndpoint\s*\(\s*\)/.test(source) || shared === null) {
    throw new Error('The checked-out website names neither a literal rendezvous nor its shared endpoint selector.');
  }
  const named = (name: string): string => {
    const endpoint = shared.match(new RegExp(`^const ${name}\\s*=\\s*['"](wss:\\/\\/[^'"]+)['"]`, 'm'))?.[1];
    if (!endpoint) throw new Error(`shared/js/peer-endpoint.js no longer names ${name}.`);
    return endpoint;
  };
  const production = named('PRODUCTION'), development = named('DEVELOPMENT');
  // These are the selector's public environment rules, asserted independently
  // so probes and frame capture watch the same service as the served preview.
  try {
    const url = new URL(href);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1'
        || (url.protocol === 'https:' && (url.hostname === 'abox-preview.pages.dev'
          || url.hostname.endsWith('.abox-preview.pages.dev')))) return development;
  } catch { /* A malformed page address has the website's production default. */ }
  return production;
}

/**
 * Does the deployed rendezvous admit pages from the origin under test?
 *
 * The worker takes a socket only from the site's own origin, loopback and the
 * pull-request previews (workers/rendezvous/worker.js, `fromOurPage`), and a page
 * from anywhere else can share nothing, which is the environment's shape and not
 * the tool's fault.
 *
 * This is read from that rule rather than asked by trying. It used to open a
 * socket, and a page cannot tell why a socket failed, so a 429 from the worker's
 * rate limit read as "not admitted": a case skipped itself in about a second,
 * blaming the deployment, at exactly the moments the suite was busiest. It also
 * cost every case a socket out of that same allowance.
 */
export function rendezvousAdmitsThisOrigin(): boolean {
  const url = new URL(BASE_URL);
  return url.origin === 'https://abox.tools' || ['localhost', '127.0.0.1'].includes(url.hostname)
    || (url.protocol === 'https:' && url.hostname.endsWith('.abox-preview.pages.dev'));
}

export function liveRendezvous(sourcePath: string): string {
  const source = fs.readFileSync(path.join(ETOOLBOX_DIR, sourcePath), 'utf8');
  const sharedPath = path.join(ETOOLBOX_DIR, 'shared/js/peer-endpoint.js');
  const shared = fs.existsSync(sharedPath) ? fs.readFileSync(sharedPath, 'utf8') : null;
  return rendezvousFromSource(source, shared, BASE_URL);
}
