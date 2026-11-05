import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

/**
 * The rendezvous lets one address open thirty sockets a minute, and a CI slice
 * is one address running four workers. Left alone, the cases that use real
 * sockets asked for three times that in their busiest minute. The worker answers
 * 429, a page cannot read the status of a refused upgrade, so it sees a closed
 * socket and says "Something went wrong while connecting"; the case then waits
 * on a control that never appears. Its retries start at once, inside the same
 * minute, and meet the same refusal. That was the red `test (mobile-chrome-2)` on
 * pull requests with no connection to any of these tools.
 *
 * So a case that opens real sockets reserves them before it starts, and waits for
 * room. The limit is the worker's and stays where it is: the suite keeps to it, as
 * the relay suite already does (lib/relay-pacing.ts, docs/cloud-relay.md). A slice
 * runs four workers where the relay suite runs one, so here the ledger is read and
 * written under a lock.
 *
 * What a case declares is what it typically opens, measured from traces. The
 * ceiling leaves room for what is not declared: a reconnect, a retry that opens a
 * few more, a page another spec merely loads.
 */
const WINDOW_MS = 61_000;
const CEILING = 24;
const LOCK_GIVEN_UP_MS = 5_000;

type Entry = { at: number; sockets: number };

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** One short read-and-write with the ledger to itself. A lock left by a dead worker is taken over. */
async function underLock<T>(ledger: string, work: () => T): Promise<T> {
  const lock = `${ledger}.lock`;
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_GIVEN_UP_MS) fs.unlinkSync(lock);
      } catch { /* released between the two calls */ }
      await sleep(25 + Math.random() * 50);
    }
  }
  try {
    return work();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* taken over; the work is done either way */ }
  }
}

function read(ledger: string): Entry[] {
  try {
    return JSON.parse(fs.readFileSync(ledger, 'utf8')) as Entry[];
  } catch {
    // Absent until the first reservation: Playwright empties the output
    // directory when a run starts, which is the only reset this should see.
    return [];
  }
}

function write(ledger: string, entries: Entry[]): void {
  const draft = `${ledger}.${process.pid}`;
  fs.writeFileSync(draft, JSON.stringify(entries));
  fs.renameSync(draft, ledger);
}

/**
 * Wait until this many sockets fit under the ceiling, and enter them. Call it
 * once, at the start of a case that opens real sockets, after its skips and its
 * `test.setTimeout`: a skipped case then costs nothing, and the wait moves the
 * case's deadline out by exactly as long, so no functional timeout pays for it.
 */
export async function reserveRendezvous(sockets: number): Promise<void> {
  const info = test.info();
  const ledger = path.join(info.project.outputDir, '.rendezvous-budget.json');
  // A case larger than the ceiling still has to run: it takes the whole window.
  const wanted = Math.min(sockets, CEILING);
  const started = Date.now();
  for (;;) {
    const delay = await underLock(ledger, () => {
      const now = Date.now();
      const live = read(ledger).filter((entry) => entry.at > now - WINDOW_MS);
      if (live.reduce((sum, entry) => sum + entry.sockets, 0) + wanted <= CEILING) {
        write(ledger, [...live, { at: now, sockets: wanted }]);
        return 0;
      }
      // Until the oldest entry falls out, and no longer. Other workers wake in
      // their own order, so nobody is promised the room it frees.
      return Math.max(250, Math.min(...live.map((entry) => entry.at)) + WINDOW_MS - now) + Math.random() * 500;
    });
    if (delay === 0) break;
    // Extended before the sleep, because a case's own clock runs during it.
    if (info.timeout > 0) info.setTimeout(info.timeout + delay);
    await sleep(delay);
  }
  const waited = Date.now() - started;
  if (waited >= 1000) info.annotations.push({ type: 'rendezvous-wait', description: `${Math.round(waited / 1000)} s` });
}
