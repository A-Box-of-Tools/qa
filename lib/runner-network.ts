import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

/**
 * Can this machine reach itself through its own public address?
 *
 * Two WebKit contexts on one Linux runner have exactly one route to each other.
 * Their host candidates carry mDNS names that nothing here resolves, so all
 * that is left is each one's public address as a STUN server saw it, and the
 * packets have to go out to the runner's NAT and be turned back. Most of
 * GitHub's runners do that. An occasional one does not: its NAT maps a socket
 * differently for each destination, so a check sent to that public address goes
 * nowhere. On such a runner every direct connection between two WebKit contexts
 * fails after fifteen seconds with no check ever received, whatever the page
 * does, and every case that needs one fails all three tries. Chromium is not
 * affected, because it resolves its own mDNS names and connects over the host
 * candidates.
 *
 * Measured with a plain RTCPeerConnection and no website involved, over eighty
 * runners, one of which could not reach itself: A-Box-of-Tools/etoolbox-lab,
 * experiments/share-text-qa-refusals. This asks the same question without a
 * browser, so a case can say what is wrong with the machine instead of failing
 * on it.
 */

/** The servers the page's own Direct mode asks, so the mapping is the one it would get. */
const STUN_SERVERS: ReadonlyArray<readonly [string, number]> = [
  ['stun.cloudflare.com', 3478],
  ['stun.l.google.com', 19302],
];
const MAGIC_COOKIE = 0x2112a442;
const STUN_DEADLINE_MS = 3000;
const REACH_DEADLINE_MS = 3000;

type Mapped = { address: string; port: number };

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function xorMappedAddress(message: Buffer): Mapped | null {
  for (let at = 20; at + 4 <= message.length;) {
    const kind = message.readUInt16BE(at);
    const length = message.readUInt16BE(at + 2);
    if (kind === 0x0020 && length >= 8 && message[at + 5] === 1) {
      const port = message.readUInt16BE(at + 6) ^ (MAGIC_COOKIE >>> 16);
      const raw = (message.readUInt32BE(at + 8) ^ MAGIC_COOKIE) >>> 0;
      return { address: [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.'), port };
    }
    at += 4 + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

/** One STUN binding request, resent until it is answered or the deadline passes. */
async function publicMapping(socket: dgram.Socket, host: string, port: number): Promise<Mapped | null> {
  const transaction = randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt32BE(MAGIC_COOKIE, 4);
  transaction.copy(request, 8);
  let mapped: Mapped | null = null;
  const onMessage = (message: Buffer) => {
    if (message.length >= 20 && message.subarray(8, 20).equals(transaction)) mapped = xorMappedAddress(message);
  };
  socket.on('message', onMessage);
  try {
    const deadline = Date.now() + STUN_DEADLINE_MS;
    while (!mapped && Date.now() < deadline) {
      await new Promise<void>((resolve) => { socket.send(request, port, host, () => resolve()); });
      await sleep(200);
    }
    return mapped;
  } finally {
    socket.off('message', onMessage);
  }
}

async function firstMapping(socket: dgram.Socket): Promise<Mapped | null> {
  for (const [host, port] of STUN_SERVERS) {
    const mapped = await publicMapping(socket, host, port);
    if (mapped) return mapped;
  }
  return null;
}

async function ask(): Promise<boolean | null> {
  const a = dgram.createSocket('udp4');
  const b = dgram.createSocket('udp4');
  const closeBoth = () => { for (const socket of [a, b]) { try { socket.close(); } catch { /* already closed */ } } };
  // An error on either socket means the question has no answer, not "no".
  let broken = false;
  for (const socket of [a, b]) socket.on('error', () => { broken = true; });
  try {
    await Promise.all([a, b].map((socket) => new Promise<void>((resolve) => { socket.bind(0, resolve); })));
    const [mappedA, mappedB] = [await firstMapping(a), await firstMapping(b)];
    if (!mappedA || !mappedB || broken) return null;
    const token = randomBytes(8);
    const heard = { a: false, b: false };
    a.on('message', (message) => { if (message.equals(token)) heard.a = true; });
    b.on('message', (message) => { if (message.equals(token)) heard.b = true; });
    const deadline = Date.now() + REACH_DEADLINE_MS;
    while (!(heard.a && heard.b) && Date.now() < deadline) {
      a.send(token, mappedB.port, mappedB.address);
      b.send(token, mappedA.port, mappedA.address);
      await sleep(50);
    }
    return broken ? null : heard.a && heard.b;
  } catch {
    return null;
  } finally {
    closeBoth();
  }
}

let answer: Promise<boolean | null> | undefined;

/**
 * True or false when the question could be put; null when no STUN server
 * answered, which says nothing about the runner and must not excuse a failure.
 * Asked once per worker: about 200 ms on an ordinary runner, and the full three
 * seconds only on one that cannot reach itself.
 */
export function runnerReachesItself(): Promise<boolean | null> {
  answer ??= ask();
  return answer;
}

export const NO_ROUTE_TO_ITSELF = 'this runner cannot reach its own public address, and two WebKit contexts on one '
  + 'Linux machine have no other route to each other (their mDNS names do not resolve here), so a direct connection '
  + 'cannot form whatever the page does. Chromium still covers this case on this run. See lib/runner-network.ts';
