import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { dictValue } from './pdf';

/**
 * Opening an encrypted PDF in Node, so the protector can be checked against
 * something other than its own report.
 *
 * WHY THIS EXISTS
 *
 * The protector's page ends with a line saying it opened its own output again
 * and found it locked, and that is the one sentence a test must not lean on:
 * a tool that wrote a broken file and a cheerful line about it would pass. The
 * reader in lib/pdf.ts cannot help either - every stream in an encrypted file
 * is ciphertext, so it finds no pages and no text, which is the same thing it
 * finds in a file with nothing in it.
 *
 * So the standard security handler is implemented here, the reading way
 * round, for the two schemes the tool writes: the PDF 2.0 one (/V 5 /R 6,
 * AES-256, the password hashed by ISO 32000-2's Algorithm 2.B) and the 2005
 * one it offers for older readers (/V 4 /R 4, AES-128 under a key derived
 * with MD5 and checked through RC4). Given a password it says whether the
 * file accepts it, and if so decrypts every stream, so a test can look for
 * the document's own text behind the lock - which is what "still the same
 * document, and nobody without the password reads it" comes down to.
 *
 * Nothing here guesses. A password is checked against the file's /U entry
 * exactly as a reader would, once, and a wrong one is reported as wrong.
 */

/** What the file's /Encrypt dictionary says about itself. */
export interface Lock {
  /** /V: 4 for the 2005 scheme, 5 for PDF 2.0. */
  version: number;
  /** /R: 4 or 6, matching. */
  revision: number;
  /** /P, the permissions field, as the signed 32-bit integer it is. */
  permissions: number;
  /** /CFM of the standard crypt filter - AESV2 or AESV3 for this tool. */
  cipher: string | null;
  /** /Length, in bits. */
  bits: number;
}

interface Dictionary extends Lock {
  U: Buffer;
  O: Buffer;
  UE: Buffer;
  /** The first element of the trailer's /ID, which the older key folds in. */
  id: Buffer;
}

const latin1 = (bytes: Buffer): string => bytes.toString('latin1');

const hexString = (body: string, key: string): Buffer => {
  const match = body.match(new RegExp(`/${key}\\s*<([0-9a-fA-F]*)>`));
  return match ? Buffer.from(match[1], 'hex') : Buffer.alloc(0);
};

/**
 * The /Encrypt dictionary, or null for a file that has none.
 *
 * Found through the trailer's reference to it: the dictionary is the one
 * object in an encrypted file that is never itself encrypted and never packed
 * into an object stream, because a reader has to be able to read it before
 * it has a key. So it is always there in the clear as `N 0 obj << ... >>`.
 */
function dictionary(bytes: Buffer): Dictionary | null {
  const raw = latin1(bytes);
  const ref = raw.match(/\/Encrypt\s+(\d+)\s+\d+\s+R/);
  if (!ref) return null;

  const at = raw.search(new RegExp(`(^|[\\r\\n])${ref[1]}\\s+0\\s+obj\\b`));
  if (at === -1) return null;
  const body = raw.slice(at, raw.indexOf('endobj', at));

  const filter = dictValue(body, 'CF') ?? '';
  const cipher = filter.match(/\/CFM\s*\/(\w+)/)?.[1] ?? null;

  const trailer = raw.slice(raw.lastIndexOf('/ID'));
  const id = trailer.match(/\/ID\s*\[\s*<([0-9a-fA-F]*)>/)?.[1] ?? '';

  return {
    version: Number(dictValue(body, 'V')),
    revision: Number(dictValue(body, 'R')),
    permissions: Number(dictValue(body, 'P')),
    cipher,
    bits: Number(dictValue(body, 'Length')),
    U: hexString(body, 'U'),
    O: hexString(body, 'O'),
    UE: hexString(body, 'UE'),
    id: Buffer.from(id, 'hex'),
  };
}

/** The facts of the lock on a file, without a password. */
export function lockOf(bytes: Buffer): Lock | null {
  const found = dictionary(bytes);
  if (!found) return null;
  const { version, revision, permissions, cipher, bits } = found;
  return { version, revision, permissions, cipher, bits };
}

/* ------------------------------------------------------------- PDF 2.0, R6 */

/**
 * ISO 32000-2 Algorithm 2.B: the hash a revision-6 password is checked by.
 *
 * SHA-256 of password, salt and (for the owner) /U, then at least 64 rounds
 * of: the password, the running hash and that same data, 64 times over,
 * encrypted with AES-128-CBC under the first half of the hash with the second
 * half as IV, and re-hashed with whichever of SHA-256, -384 or -512 the sum of
 * the first sixteen ciphertext bytes picks. It stops once past round 64 and
 * the last byte of the ciphertext is no bigger than the round number less 32.
 * Written from the standard rather than copied from the tool, which is the
 * point of checking here at all.
 */
function hash2B(password: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = crypto.createHash('sha256').update(Buffer.concat([password, salt, udata])).digest();
  let e = Buffer.alloc(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i += 1) {
    const k1 = Buffer.concat(Array<Buffer>(64).fill(Buffer.concat([password, k, udata])));
    const aes = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    aes.setAutoPadding(false);
    e = Buffer.concat([aes.update(k1), aes.final()]);
    let sum = 0;
    for (let j = 0; j < 16; j += 1) sum += e[j];
    k = crypto.createHash(['sha256', 'sha384', 'sha512'][sum % 3]).update(e).digest();
  }
  return k.subarray(0, 32);
}

/** The file key under revision 6, or null when the password is not the user's. */
function fileKey6(lock: Dictionary, password: Buffer): Buffer | null {
  if (lock.U.length < 48 || lock.UE.length !== 32) return null;
  const validationSalt = lock.U.subarray(32, 40);
  const keySalt = lock.U.subarray(40, 48);
  if (!hash2B(password, validationSalt, Buffer.alloc(0)).equals(lock.U.subarray(0, 32))) return null;

  const aes = crypto.createDecipheriv('aes-256-cbc', hash2B(password, keySalt, Buffer.alloc(0)),
    Buffer.alloc(16));
  aes.setAutoPadding(false);
  return Buffer.concat([aes.update(lock.UE), aes.final()]);
}

/* -------------------------------------------------------------- 2005, R4 */

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** RC4, which OpenSSL no longer ships and the 2005 scheme still checks /U with. */
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts: Buffer[]): Buffer => crypto.createHash('md5').update(Buffer.concat(parts)).digest();

/**
 * The file key under revision 4 (ISO 32000-1 Algorithm 2), or null when the
 * password is not the user's (Algorithms 4 and 5).
 *
 * The key is MD5 over the padded password, /O, /P as four little-endian
 * bytes and the first /ID, folded fifty more times. It is right when /U's
 * first sixteen bytes are MD5 of the padding and that /ID, put through RC4
 * under the key and then nineteen more times under the key with each byte
 * XORed by the round number.
 */
function fileKey4(lock: Dictionary, password: Buffer): Buffer | null {
  const n = lock.bits / 8 || 5;
  const padded = Buffer.concat([password, PAD]).subarray(0, 32);
  const p = Buffer.alloc(4);
  p.writeInt32LE(lock.permissions);
  let key = md5(padded, lock.O.subarray(0, 32), p, lock.id).subarray(0, n);
  for (let i = 0; i < 50; i += 1) key = md5(key).subarray(0, n);

  let check = rc4(key, md5(PAD, lock.id));
  for (let i = 1; i <= 19; i += 1) {
    check = rc4(Buffer.from(key.map((byte) => byte ^ i)), check);
  }
  return check.equals(lock.U.subarray(0, 16)) ? key : null;
}

/** The per-object key the 2005 scheme derives for each stream (Algorithm 1). */
function objectKey4(fileKey: Buffer, num: number, gen: number): Buffer {
  const tail = Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff,
    gen & 0xff, (gen >> 8) & 0xff, 0x73, 0x41, 0x6c, 0x54]);
  return md5(fileKey, tail).subarray(0, Math.min(fileKey.length + 5, 16));
}

/* ----------------------------------------------------------------- opening */

export interface Opened {
  /** Whether the password is the one the file opens with. */
  ok: boolean;
  /** Every string drawn by any decrypted content stream, in file order. */
  text: string[];
  /** How many streams were decrypted and read. */
  streams: number;
}

/**
 * Open an encrypted file with a password and read what is behind the lock.
 *
 * Every `N 0 obj << ... >> stream` in the file is decrypted with the key the
 * password yields - AES-256-CBC with the block's own IV under revision 6,
 * AES-128-CBC under a per-object key for revision 4 - and un-Flated where the
 * dictionary says so. The text is then whatever any of them draws, which for
 * an object that was a content stream is the document's words and for an
 * object stream is nothing. A file this cannot open is reported as `ok:
 * false` with no text, not thrown at: a refused password is a result.
 */
export function opened(bytes: Buffer, password: string): Opened {
  const lock = dictionary(bytes);
  if (!lock) return { ok: false, text: [], streams: 0 };

  const typed = Buffer.from(password, 'utf8').subarray(0, 127);
  const key = lock.revision >= 5 ? fileKey6(lock, typed) : fileKey4(lock, typed);
  if (!key) return { ok: false, text: [], streams: 0 };

  const raw = latin1(bytes);
  const text: string[] = [];
  let streams = 0;
  for (const head of raw.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\s*(<<[\s\S]*?>>)\s*stream\r?\n/g)) {
    const num = Number(head[1]);
    const gen = Number(head[2]);
    const body = head[3];
    const start = head.index! + head[0].length;
    const length = Number(dictValue(body, 'Length'));
    if (!Number.isFinite(length)) continue;
    const data = bytes.subarray(start, start + length);
    if (data.length < 32) continue;

    let plain: Buffer;
    try {
      const aes = lock.revision >= 5
        ? crypto.createDecipheriv('aes-256-cbc', key, data.subarray(0, 16))
        : crypto.createDecipheriv('aes-128-cbc', objectKey4(key, num, gen), data.subarray(0, 16));
      plain = Buffer.concat([aes.update(data.subarray(16)), aes.final()]);
    } catch {
      continue;
    }
    if (/\/FlateDecode/.test(body)) {
      try { plain = zlib.inflateSync(plain); } catch { continue; }
    }
    streams += 1;
    for (const drawn of latin1(plain).matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) text.push(drawn[1]);
  }

  return { ok: true, text, streams };
}
