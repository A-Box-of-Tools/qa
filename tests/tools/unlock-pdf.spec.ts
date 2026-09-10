import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { allText, readPages } from '../../lib/pdf';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the PDF unlocker.
 *
 * WHAT THIS TOOL PROMISES, AND WHICH HALF IS WORTH A TEST
 *
 * Two of its claims are about what it refuses to do - it will not guess a
 * password, and there is no loop in `src/crypt.js` to do it with - and neither
 * is a thing a browser test can watch. They are read off the source, and the
 * website's own suite is where that belongs.
 *
 * What is testable is the claim the visitor actually leaves with: that the
 * file they downloaded is the same document with the encryption gone. The page
 * says so itself, in a line under the result that reports re-opening its own
 * output from memory with no password. That line is the tool marking its own
 * work, and it is exactly the assertion not to lean on: a tool that wrote a
 * broken file and a cheerful sentence about it would pass.
 *
 * So the file is read again here, in Node, off the disk the browser saved it
 * to. No `/Encrypt` anywhere in it, the same number of pages the page said,
 * and the text still in them. The first is the whole job; the second and third
 * are what stops "no encryption" being achieved by writing nothing much.
 *
 * WHY THE INPUT IS NOT CHECKED THE SAME WAY
 *
 * The example is built inside the page rather than handed to `#file-input`, so
 * there are no input bytes out here to inspect. That it arrived encrypted is
 * established from the page instead, and firmly: the report names the scheme
 * and revision it found and lists the restrictions it read out of `/P`, and
 * neither of those exists to be read in an unencrypted file.
 */

const URL_PATH = '/unlock-pdf/';

/**
 * Whether the site under test has this tool at all.
 *
 * The tool and its spec live in different repositories and cannot land in one
 * change, so this file exists while /unlock-pdf/ is still on the website's
 * `dev`. Asked of the checkout the run was given, like everything else here.
 */
const SHIPPED = discoverTools().includes('unlock-pdf');
const NOT_YET = 'this site does not ship unlock-pdf yet';

/**
 * Press the example button and wait for the tool to have read the document.
 *
 * Waited on by `#scheme-what`, which is empty and hidden until a document has
 * actually been opened. Not by `#report-card`: steps 2 and 3 of this page are
 * on screen from the first paint, explaining themselves before anybody has
 * chosen anything, so waiting for the card to appear is waiting for something
 * that is already there.
 */
async function loadTheExample(page: Page): Promise<void> {
  await page.locator('#example-button').click();
  await expect(page.locator('#scheme-what')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#scheme-what')).not.toBeEmpty({ timeout: 30_000 });
  await expect(
    page.locator('#load-error'),
    'the tool refused its own example document',
  ).toBeHidden();
}

/** Take the protection off and save what the browser writes. */
async function unlocked(page: Page): Promise<Buffer> {
  // No wait on the button's enabled state: it is enabled from the first paint,
  // like the card around it. The document being read is what gates this, and
  // loadTheExample has already waited for that.
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout: 90_000 });
  await expect(
    page.locator('#run-error'),
    'the tool failed on its own example document',
  ).toBeHidden();

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const where = await saved.path();
  if (!where) throw new Error('the browser saved no file');
  return fs.readFileSync(where);
}

test.describe('unlock-pdf: the document it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('says which of the two protections this document has', async ({ page }) => {
    await loadTheExample(page);

    // The page's first job is not to unlock anything - it is to tell apart a
    // document nobody can open from one that opens for everybody and merely
    // asks readers to behave. The example is the second kind, so nothing may
    // ask for a password.
    await expect(
      page.locator('#password-row'),
      'it asked for a password for a document that opens without one',
    ).toBeHidden();

    // What it found in the file, which is only readable because the file was
    // encrypted: the handler's name and revision, and the restrictions out
    // of /P.
    await expect(page.locator('#scheme-what')).not.toBeEmpty();
    await expect(
      page.locator('#restriction-list li'),
      'a restricted document came back with no restrictions listed',
    ).not.toHaveCount(0);

    await expect(
      page.locator('#verdict'),
      'the verdict did not say which of the two situations this is',
    ).toContainText(/password|locked|restrict/i);
  });

  test('the file it writes has no encryption left in it', async ({ page }) => {
    await loadTheExample(page);

    // Read off the page before the run, so the comparison afterwards is
    // against what this document actually is rather than against a number
    // written down here.
    const restrictions = await page.locator('#restriction-list li').count();
    expect(restrictions, 'the example lists no restrictions to lift').toBeGreaterThan(0);

    const bytes = await unlocked(page);

    // The whole job. `/Encrypt` in the trailer is what makes a PDF encrypted;
    // a file that still carries one has not been unlocked, whatever the page
    // said about it.
    const raw = bytes.toString('latin1');
    expect(
      raw.includes('/Encrypt'),
      'the saved file still carries an /Encrypt dictionary',
    ).toBe(false);

    // And it is still the document. "No encryption" is trivially achievable
    // by writing something empty, so the pages and their text have to survive
    // it - which is also the tool's own claim about what it kept.
    const pages = readPages(bytes);
    expect(pages.length, 'the unlocked file has no pages in it').toBeGreaterThan(0);
    expect(
      allText(bytes).join('').trim().length,
      'the unlocked file has pages but no text left in them',
    ).toBeGreaterThan(0);

    // The page reports its own page count in the line under the result. It
    // has to be the count the file really has, because that sentence is what
    // a visitor reads instead of opening the file.
    const said = (await page.locator('#check-line').textContent()) ?? '';
    const claimed = Number(said.match(/(\d+)\s*pages?/)?.[1]);
    if (Number.isFinite(claimed)) {
      expect(claimed, `the page claims ${claimed} pages and the file has ${pages.length}`)
        .toBe(pages.length);
    }
  });
});

test.describe('unlock-pdf: what it refuses', () => {
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

    // Refused means nothing was read, not that the page went away: steps 2 and
    // 3 stay on screen explaining themselves. What must not appear is any
    // finding about a document - a scheme it identified, or the file taken as
    // chosen.
    await expect(
      page.locator('#scheme-what'),
      'a file it refused still produced a scheme',
    ).toBeHidden();
    await expect(
      page.locator('#file-row'),
      'a file it refused was still taken as the chosen document',
    ).toBeHidden();
  });
});
