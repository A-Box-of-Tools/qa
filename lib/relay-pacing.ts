import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestInfo } from '@playwright/test';

const WINDOW_MS = 61_000;
const RESERVATION = 10;
const CEILING = 20;
type Entry = { id: string; at: number; connections: number };

/** The worker allows 30 introductions per minute from one address. Reserve
 * below that cap, leaving room for normal recovery. The ledger survives a
 * failed Playwright worker; a new worker must not reset the traffic budget. */
export async function reserveRelayStart(info: TestInfo, extendTimeout: (milliseconds: number) => void) {
  if (info.config.workers !== 1) throw new Error('Real relay pacing requires exactly one Playwright worker.');
  const ledger = path.join(info.project.outputDir, '.relay-start-budget.json');
  const read = (): Entry[] => {
    let contents: string;
    try { contents = fs.readFileSync(ledger, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = JSON.parse(contents);
    if (!Array.isArray(entries) || entries.some(entry => typeof entry?.id !== 'string'
      || !Number.isFinite(entry.at) || !Number.isInteger(entry.connections) || entry.connections < RESERVATION)) {
      throw new Error('The relay pacing ledger is invalid; refusing to reset its traffic budget.');
    }
    return entries;
  };
  const write = (entries: Entry[]) => {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    const temporary = ledger + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(entries));
    fs.renameSync(temporary, ledger);
  };
  let waited = 0;
  const id = randomUUID();
  for (;;) {
    const now = Date.now();
    const entries = read().filter(entry => entry.at > now - WINDOW_MS);
    if (entries.reduce((sum, entry) => sum + entry.connections, 0) + RESERVATION <= CEILING) {
      write([...entries, { id, at: now, connections: RESERVATION }]);
      break;
    }
    const delay = Math.max(1, Math.min(...entries.map(entry => entry.at)) + WINDOW_MS - now + 1);
    // Only this deliberate pre-start delay extends the outer test budget.
    // Browser setup and every functional assertion keep their original limit.
    const waitingSince = Date.now();
    await new Promise(resolve => setTimeout(resolve, delay));
    const elapsed = Date.now() - waitingSince;
    extendTimeout(elapsed);
    waited += elapsed;
  }
  return {
    waited,
    finish(observed: number) {
      const now = Date.now();
      const connections = Math.max(RESERVATION, observed);
      const entries = read().filter(entry => entry.id !== id && entry.at > now - WINDOW_MS);
      // Completion is later than every handshake observed in this case, so
      // even a slow failure's final reconnect remains inside the next window.
      write([...entries, { id, at: now, connections }]);
      return { observed, reserved: RESERVATION, exceeded: observed > RESERVATION, waitedMs: waited };
    },
  };
}
