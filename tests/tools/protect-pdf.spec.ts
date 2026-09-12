import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { lockOf, opened } from '../../lib/pdf-lock';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the PDF protector.
 *
 * WHAT THIS TOOL PROMISES, AND HOW MUCH OF IT CAN BE CHECKED
 *
 * The page is careful to say that "protected" is two different things: an
 * open password, which genuinely enciphers the document, and restrictions,
 * which are a request to readers that any reader may decline. A test has to
 * hold on to the same distinction, because the file that proves the first
 * claim looks nothing like the file that proves the second.
 *
 * The page also ends every run with a line saying it opened its own output
 * again, refused without the password and readable with it. That is the tool
 * marking its own work and it is exactly the sentence not to lean on. So the
 * file the browser saved is opened here, in Node, by lib/pdf-lock.ts - the
 * standard security handler written the reading way round, from the
 * specification rather than from the tool - and what is asserted is what a
 * reader would find: the wrong password is refused, the right one yields the
 * key, and behind the key are the example's own words, page by page. The
 * words are also looked for in the clear, where they must not be; on their
 * own that would prove little, since the streams are compressed anyway, but
 * beside the decrypted copy it is the difference between hidden and gone.
 *
 * The restrictions go into /P as bits, and the bits are compared against the
 * table in ISO 32000 rather than against what the page says it did, for the
 * same reason.
 *
 * WHAT IS LEFT TO THE WEBSITE'S OWN SUITE
 *
 * That the owner password is random when none is set, and that nothing here
 * guesses, are facts about the source and are tested there.
 */

const URL_PATH = '/protect-pdf/';

/**
 * Whether the site under test has this tool at all.
 *
 * The tool and its spec live in different repositories and cannot land in
 * one change, so this file exists while /protect-pdf/ is still on the
 * website's `dev`. Asked of the checkout the run was given.
 */
const SHIPPED = discoverTools().includes('protect-pdf');
const NOT_YET = 'this site does not ship protect-pdf yet';

/**
 * ISO 32000-1 table 22, the bits of /P: numbered from 1, and a bit that is
 * set permits the thing. Printing is bit 3, and bit 12 for printing at full
 * quality; copying is bit 5; changing the document is bit 4, with 6 for
 * annotating, 9 for filling forms and 11 for assembling. Written down here
 * from the standard so the comparison is against it, not against the tool's
 * own table.
 */
const BIT = (n: number) => 1 << (n - 1);
const PRINTING = BIT(3) | BIT(12);
const COPYING = BIT(5);
const CHANGING = BIT(4) | BIT(6) | BIT(9) | BIT(11);

/** Long enough that the page says nothing about its length. */
const PASSWORD = 'correct horse battery';

/** The two page headings the example is built with, one per page. */
const PAGE_HEADINGS = ['STATEMENT 1 / 2', 'STATEMENT 2 / 2'];

/** Press the example button and wait for the tool to have read the document. */
async function loadTheExample(page: Page): Promise<void> {
  await page.locator('#example-button').click();
  await expect(page.locator('#file-row')).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator('#load-error'),
    'the tool refused its own example document',
  ).toBeHidden();
}

/** Type the same password into both boxes. */
async function setPassword(page: Page, password: string): Promise<void> {
  await page.locator('#password').fill(password);
  await page.locator('#password-again').fill(password);
}

/**
 * Run the protector and save what the browser writes.
 *
 * The download link is only shown when the page's own re-opening check
 * passed, so a run whose link never appears is a run the tool did not trust
 * either - and `#check-line` says why, which is what the failure reads out.
 */
async function protectedFile(page: Page): Promise<Buffer> {
  await expect(
    page.locator('#run-card'),
    'the last card is still waiting for the settings to agree',
  ).not.toHaveAttribute('inert', '');
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 90_000 });
  await expect(
    page.locator('#run-error'),
    'the tool failed on its own example document',
  ).toBeHidden();
  await expect(
    page.locator('#check-line'),
    `the tool did not trust its own output: ${await page.locator('#check-line').textContent()}`,
  ).toHaveClass(/\bgood\b/);

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const where = await saved.path();
  if (!where) throw new Error('the browser saved no file');
  return fs.readFileSync(where);
}

test.describe('protect-pdf: the settings gate', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('nothing runs until the two passwords agree', async ({ page }) => {
    await page.goto(URL_PATH);
    await loadTheExample(page);

    // A file alone is not enough: the last card sleeps until something has
    // been asked for, and a password typed once is not yet a request.
    const runCard = page.locator('#run-card');
    await expect(runCard).toHaveAttribute('inert', '');

    await page.locator('#password').fill(PASSWORD);
    await expect(
      page.locator('#password-status'),
      'one box filled and the other empty was not called a mismatch',
    ).toContainText(/match/i);
    await expect(runCard).toHaveAttribute('inert', '');

    await page.locator('#password-again').fill(PASSWORD);
    await expect(
      page.locator('#password-status'),
      'the status did not report the agreed password by its length',
    ).toContainText(String(PASSWORD.length));
    await expect(runCard, 'the passwords agree and the card is still asleep')
      .not.toHaveAttribute('inert', '');
  });
});

test.describe('protect-pdf: the document it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
    await loadTheExample(page);
  });

  test('a password locks it, and everything is still there behind the lock', async ({ page }) => {
    await setPassword(page, PASSWORD);
    await page.locator('#restrict-print').check();
    await page.locator('#restrict-copy').check();

    const bytes = await protectedFile(page);
    await expect(
      page.locator('#result-size'),
      'the result did not say the file needs the password',
    ).toContainText(/password/i);

    // What the file says about itself: the PDF 2.0 handler, which is the
    // default and the one the facts under the result call AES-256.
    const lock = lockOf(bytes);
    expect(lock, 'the saved file carries no /Encrypt dictionary').not.toBeNull();
    expect(lock).toMatchObject({ version: 5, revision: 6, cipher: 'AESV3', bits: 256 });

    // The restrictions, as the bits a reader would read: printing and
    // copying cleared, changing left alone, and every other bit still set.
    expect(lock!.permissions, 'the /P bits are not the two restrictions that were ticked')
      .toBe(-1 & ~(PRINTING | COPYING));

    // Refused without the password - the check is against /U, as a reader's
    // is - and open with it, with both pages' headings where they should be.
    // The headings are searched for in the clear first: a file that still
    // shows them to anyone has not been enciphered whatever its trailer says.
    const raw = bytes.toString('latin1');
    for (const heading of PAGE_HEADINGS) {
      expect(raw.includes(heading), `"${heading}" is readable without the password`).toBe(false);
    }
    expect(opened(bytes, 'not the password').ok, 'a wrong password opened the file').toBe(false);
    expect(opened(bytes, '').ok, 'no password at all opened the file').toBe(false);

    const behind = opened(bytes, PASSWORD);
    expect(behind.ok, 'the password that was set does not open the file').toBe(true);
    expect(behind.streams, 'the password opened the file but nothing in it decrypted')
      .toBeGreaterThan(0);
    for (const heading of PAGE_HEADINGS) {
      expect(behind.text, `"${heading}" is not in the file behind the password`)
        .toContain(heading);
    }
  });

  test('restrictions alone leave it open to everybody', async ({ page }) => {
    // No password: the page has to say, before anything runs, that this
    // document will still open for everyone.
    await page.locator('#restrict-change').check();
    await expect(
      page.locator('#password-status'),
      'restrictions with no password were not described as leaving the file open',
    ).toContainText(/open/i);

    const bytes = await protectedFile(page);
    await expect(
      page.locator('#result-size'),
      'the result did not say the file opens for everybody',
    ).toContainText(/everybody/i);

    // Still an encrypted file in the format's sense - restrictions have no
    // other home than /Encrypt - but one whose user password is empty, so
    // that a reader opens it with nothing and merely reads the request in /P.
    const lock = lockOf(bytes);
    expect(lock, 'a restricted file was saved with no /Encrypt dictionary').not.toBeNull();
    expect(lock!.permissions, 'the /P bits are not "no changes" and nothing else')
      .toBe(-1 & ~CHANGING);

    const behind = opened(bytes, '');
    expect(behind.ok, 'a file with no open password did not open with none').toBe(true);
    for (const heading of PAGE_HEADINGS) {
      expect(behind.text, `"${heading}" is not in the file`).toContain(heading);
    }
  });

  test('the older scheme writes the 2005 handler, and still opens with the password', async ({ page }) => {
    await setPassword(page, PASSWORD);
    await page.locator('input[name="scheme"][value="4"]').check();

    const bytes = await protectedFile(page);

    const lock = lockOf(bytes);
    expect(lock, 'the saved file carries no /Encrypt dictionary').not.toBeNull();
    expect(lock).toMatchObject({ version: 4, revision: 4, cipher: 'AESV2', bits: 128 });
    expect(lock!.permissions, 'no restriction was ticked and /P is not all ones').toBe(-1);

    expect(opened(bytes, 'not the password').ok, 'a wrong password opened the file').toBe(false);
    const behind = opened(bytes, PASSWORD);
    expect(behind.ok, 'the password that was set does not open the file').toBe(true);
    for (const heading of PAGE_HEADINGS) {
      expect(behind.text, `"${heading}" is not in the file behind the password`)
        .toContain(heading);
    }
  });
});

test.describe('protect-pdf: what it refuses', () => {
  test.skip(!SHIPPED, NOT_YET);

  test('something that is not a PDF is refused, and said so', async ({ page }) => {
    await page.goto(URL_PATH);

    await page.locator('#file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not a pdf at all\n', 'utf8'),
    });

    await expect(page.locator('#load-error')).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('#load-error'),
      'the page refused the file without saying it was not a PDF',
    ).toContainText(/PDF/i);
    await expect(
      page.locator('#file-row'),
      'a file it refused was still taken as the chosen document',
    ).toBeHidden();
  });
});
