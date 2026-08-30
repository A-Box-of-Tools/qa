import { test, expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for Hash & Checksum.
 *
 * This tool implements MD5, SHA-1, SHA-256, SHA-384 and SHA-512 in JavaScript
 * by hand, on purpose: crypto.subtle.digest has no incremental form, so using
 * it would mean holding the whole file in one buffer and the largest file
 * checkable would become the largest buffer the tab is allowed - on a phone,
 * a few hundred megabytes, and "the file people most want to check is a disk
 * image".
 *
 * Hand-written hashing is exactly the kind of code that is either right or
 * quietly, catastrophically wrong: a checksum tool that returns a plausible
 * but incorrect digest tells people a good download is corrupt, or a corrupt
 * one is fine. So these tests do not check that a digest looks like hex. They
 * check it against Node's crypto - OpenSSL, a completely independent
 * implementation - and against the published vectors both would have to be
 * wrong in the same way to pass.
 *
 * The chunked reading that motivated all of it is tested where it can break:
 * on a file large enough to cross the chunk boundary several times.
 */

const URL_PATH = '/hash-checksum/';

const ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'] as const;
type Algorithm = (typeof ALGORITHMS)[number];

/** What Node's crypto calls each of them. */
const NODE_NAME: Record<Algorithm, string> = {
  md5: 'md5',
  sha1: 'sha1',
  sha256: 'sha256',
  sha384: 'sha384',
  sha512: 'sha512',
};

const digestOf = (algorithm: Algorithm, data: Buffer): string => (
  crypto.createHash(NODE_NAME[algorithm]).update(data).digest('hex')
);

/**
 * The published digests of the empty input.
 *
 * Written out rather than computed so that this suite is anchored to
 * something outside both implementations. Node agreeing with the tool proves
 * they match; these prove what they match is the right answer.
 */
const EMPTY_VECTORS: Record<Algorithm, string> = {
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sha384: '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da'
    + '274edebfe76f65fbd51ad2f14898b95b',
  sha512: 'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce'
    + '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
};

/** Tick exactly the algorithms named, before the file is chosen. */
async function chooseAlgorithms(page: Page, wanted: Algorithm[]): Promise<void> {
  for (const algorithm of ALGORITHMS) {
    const box = page.locator(`input[data-algorithm="${algorithm}"]`);
    if (wanted.includes(algorithm)) await box.check();
    else await box.uncheck();
  }
}

/** Hand the tool a file and wait until every ticked digest has been written. */
async function hash(page: Page, data: Buffer, name = 'download.bin'): Promise<void> {
  await page.locator('#file-input').setInputFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer: data,
  });
  await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#progress')).toBeHidden({ timeout: 60_000 });
}

/** The digest the page is showing for one algorithm. */
async function shown(page: Page, algorithm: Algorithm): Promise<string> {
  const row = page.locator(`li.digest[data-algorithm="${algorithm}"]`);
  await expect(row).toBeVisible();
  const value = row.locator('[data-slot="value"]');
  await expect(value).not.toBeEmpty({ timeout: 30_000 });
  return ((await value.textContent()) ?? '').trim().toLowerCase();
}

test.describe('hash-checksum: the digests themselves', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('an empty file gives the published digest of nothing', async ({ page }) => {
    // The one input every hash specification writes down, so this catches an
    // implementation that is wrong about padding - which is where a
    // from-scratch hash usually is wrong, and which no amount of "it looks
    // like hex" would notice.
    await chooseAlgorithms(page, [...ALGORITHMS]);
    await hash(page, Buffer.alloc(0), 'empty.bin');

    for (const algorithm of ALGORITHMS) {
      expect(await shown(page, algorithm), `${algorithm} of an empty file`)
        .toBe(EMPTY_VECTORS[algorithm]);
      // And the anchor is itself correct.
      expect(EMPTY_VECTORS[algorithm]).toBe(digestOf(algorithm, Buffer.alloc(0)));
    }
  });

  test('"abc" gives what every specification says it gives', async ({ page }) => {
    const abc = Buffer.from('abc', 'latin1');
    await chooseAlgorithms(page, [...ALGORITHMS]);
    await hash(page, abc, 'abc.txt');

    for (const algorithm of ALGORITHMS) {
      expect(await shown(page, algorithm), `${algorithm} of "abc"`)
        .toBe(digestOf(algorithm, abc));
    }
  });

  test('a file with every byte value in it agrees with OpenSSL', async ({ page }) => {
    // Not text: a digest that mangles high bytes, or that goes through a
    // string somewhere, passes on "abc" and fails here.
    const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await chooseAlgorithms(page, [...ALGORITHMS]);
    await hash(page, every, 'bytes.bin');

    for (const algorithm of ALGORITHMS) {
      expect(await shown(page, algorithm), `${algorithm} of all 256 byte values`)
        .toBe(digestOf(algorithm, every));
    }
  });

  test('lengths either side of a block boundary are right', async ({ page }) => {
    // MD5, SHA-1 and SHA-256 work in 64-byte blocks; SHA-384 and SHA-512 in
    // 128. The lengths that break a hand-written padding routine are the ones
    // just under, exactly on, and just over one - especially 55/56, where the
    // length field stops fitting in the final block and a whole extra block
    // has to be appended.
    //
    // Eleven lengths means eleven loads, which is comfortably inside the
    // default budget alone and outside it when the other workers are busy
    // hashing nine megabytes. Given its own budget rather than trimmed: the
    // boundary lengths are the point of the test, and dropping some to fit a
    // timeout would be dropping the cases most likely to be wrong.
    test.setTimeout(180_000);

    await chooseAlgorithms(page, ['sha256', 'sha512']);

    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const data = Buffer.alloc(length, 0xa5);
      await page.goto(URL_PATH);
      await chooseAlgorithms(page, ['sha256', 'sha512']);
      await hash(page, data, `len-${length}.bin`);

      expect(await shown(page, 'sha256'), `sha256 of ${length} bytes`)
        .toBe(digestOf('sha256', data));
      expect(await shown(page, 'sha512'), `sha512 of ${length} bytes`)
        .toBe(digestOf('sha512', data));
    }
  });

  test('a file bigger than one read chunk is still hashed correctly', async ({ page }) => {
    // The whole reason this tool hashes incrementally instead of calling
    // crypto.subtle. Reading in 4 MB chunks means state has to be carried
    // across the joins, and a bug there shows up only on a file long enough
    // to have joins - never on the small ones a quick test would use.
    const size = 9 * 1024 * 1024 + 12345; // several chunks, ending mid-chunk
    const data = Buffer.alloc(size);
    // Deterministic but not uniform: a run of identical bytes can hide an
    // offset error that varied content exposes.
    for (let i = 0; i < size; i += 1) data[i] = (i * 31 + (i >> 13)) & 0xff;

    await chooseAlgorithms(page, ['md5', 'sha256']);
    await hash(page, data, 'large.bin');

    expect(await shown(page, 'md5')).toBe(digestOf('md5', data));
    expect(await shown(page, 'sha256')).toBe(digestOf('sha256', data));
  });

  test('only the ticked algorithms are worked out', async ({ page }) => {
    await chooseAlgorithms(page, ['sha1']);
    await hash(page, Buffer.from('abc', 'latin1'));

    await expect(page.locator('li.digest[data-algorithm="sha1"]')).toBeVisible();
    for (const algorithm of ['md5', 'sha256', 'sha384', 'sha512'] as Algorithm[]) {
      await expect(page.locator(`li.digest[data-algorithm="${algorithm}"]`)).toBeHidden();
    }
  });
});

test.describe('hash-checksum: comparing against a pasted value', () => {
  const data = Buffer.from('the quick brown fox', 'latin1');

  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await chooseAlgorithms(page, ['sha256']);
    await hash(page, data, 'fox.txt');
  });

  test('the right checksum is called a match', async ({ page }) => {
    await page.locator('#expected').fill(digestOf('sha256', data));

    await expect(page.locator('#verdict')).toBeVisible();
    await expect(page.locator('[data-outcome="match"]')).toBeVisible();
    await expect(page.locator('[data-outcome="mismatch"]')).toBeHidden();
    await expect(page.locator('li.digest[data-algorithm="sha256"] [data-slot="match"]')).toBeVisible();
  });

  test('a checksum for different bytes is called a mismatch', async ({ page }) => {
    // One character different from the real answer, which is the shape a real
    // corrupted download takes - not a random string.
    const real = digestOf('sha256', data);
    const wrong = `${real.slice(0, -1)}${real.at(-1) === 'a' ? 'b' : 'a'}`;

    await page.locator('#expected').fill(wrong);

    await expect(page.locator('[data-outcome="mismatch"]')).toBeVisible();
    await expect(page.locator('[data-outcome="match"]')).toBeHidden();
    await expect(page.locator('li.digest[data-algorithm="sha256"] [data-slot="differs"]')).toBeVisible();
  });

  test('case and surrounding whitespace do not matter', async ({ page }) => {
    // A checksum copied off a release page arrives with a newline on it, and
    // plenty of pages print them in capitals.
    await page.locator('#expected').fill(`  ${digestOf('sha256', data).toUpperCase()}\n`);
    await expect(page.locator('[data-outcome="match"]')).toBeVisible();
  });

  test('a whole sha256sum line is understood, not just bare hex', async ({ page }) => {
    // The output of `sha256sum` - digest, two spaces, filename - which is what
    // people actually have in their clipboard.
    await page.locator('#expected').fill(`${digestOf('sha256', data)}  fox.txt`);

    await expect(page.locator('#expected-read')).toBeVisible();
    await expect(page.locator('[data-outcome="match"]')).toBeVisible();
  });

  test('the algorithm is worked out from the length of what was pasted', async ({ page }) => {
    // Nothing to pick: a 40-character value is a SHA-1 and a 64-character one
    // is a SHA-256, and the page says which it decided.
    await page.locator('#expected').fill(digestOf('sha256', data));
    await expect(page.locator('#expected-read [data-slot="algorithm"]')).toContainText(/SHA-256/i);
  });

  test('something that is not a checksum at all is said to be that', async ({ page }) => {
    await page.locator('#expected').fill('this is not a checksum');
    await expect(page.locator('#expected-read [data-read="nothing"]')).toBeVisible();
  });
});

test.describe('hash-checksum: the promise', () => {
  test('the file never leaves the page', async ({ page }) => {
    await page.goto(URL_PATH);

    const traffic: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' || req.url().length > 500) {
        traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 4000)}`);
      }
    });

    const data = Buffer.from('a secret document nobody should see', 'latin1');
    await chooseAlgorithms(page, ['sha256']);
    await hash(page, data, 'secret.txt');
    await quiet(page);

    const digest = digestOf('sha256', data);
    for (const entry of traffic) {
      expect(entry, 'the file content was sent').not.toContain('a secret document');
      // The digest leaving would be enough to confirm to a server which file
      // somebody has, which is the thing a hashing tool must not do either.
      expect(entry, 'the digest was sent').not.toContain(digest);
    }
  });
});
