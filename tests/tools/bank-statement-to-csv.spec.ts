import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

/**
 * Tool-level functional tests for the bank statement converter.
 *
 * WHAT IS WORTH TESTING HERE, AND WHAT IS NOT
 *
 * There is no table in a PDF - there is text placed at positions, and the
 * columns a reader sees are strips of paper nobody printed in. So this tool
 * infers a table rather than reading one, and every stage of that inference
 * can be wrong on a layout nobody has seen. Its own README says as much: the
 * extraction is the easy half, and the checking is what makes it trustworthy.
 *
 * That shapes these tests. Asserting that the page says "the balance adds up"
 * would be testing the tool against its own opinion of itself, which is the
 * one thing a converter is guaranteed to agree with. So the arithmetic is
 * done again here, in Node, over the CSV the browser actually saved: every
 * row's balance has to be the row above plus that row's amount. If the
 * columns were misread, a row was dropped, or a wrapped description was
 * counted as its own transaction, that chain breaks at the row it happened
 * on - which is exactly why the tool uses it, and exactly why an independent
 * copy of it is worth having.
 *
 * THE FIXTURE IS THE TOOL'S OWN EXAMPLE
 *
 * `#example-button` builds a three-page statement in the page, with signed
 * amounts and a running balance. Using it rather than a PDF built here is
 * deliberate twice over: the example is what a first-time visitor presses, so
 * it is worth knowing it works, and a statement written by this repository
 * would only prove the tool can read documents shaped the way its tests
 * expect. What is checked is not the example's contents - those are the
 * site's to change - but that whatever it contains comes out internally
 * consistent.
 */

const URL_PATH = '/bank-statement-to-csv/';

/** One row of the CSV, as far as this file cares about it. */
interface Row {
  date: string;
  amount: number;
  balance: number;
}

/**
 * Split a line of RFC 4180 CSV.
 *
 * A parser rather than a `split(',')` because the tool quotes descriptions,
 * and a description with a comma in it is exactly the case where a naive
 * split reports the file as broken when it is correct.
 */
function cells(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

/** Press the example button and wait for the tool to finish with it. */
async function convertTheExample(page: Page): Promise<void> {
  await page.locator('#example-button').click();
  // Reading a three-page PDF and inferring its columns is real work, and the
  // WebKit projects take several times as long over it as the Chromium ones.
  await expect(page.locator('#result-card')).toBeVisible({ timeout: 90_000 });
  await expect(
    page.locator('#load-error'),
    'the tool refused its own example statement',
  ).toBeHidden();
}

/** Save the CSV the way a visitor would, and read it back off the disk. */
async function savedCsv(page: Page): Promise<string> {
  // Through the browser's own download rather than by fetching the blob URL:
  // this tool's Content-Security-Policy does not open connect-src to blob:,
  // so a fetch of its own result is refused - correctly, and the download is
  // what a visitor uses anyway.
  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const where = await saved.path();
  if (!where) throw new Error('the browser saved no file');
  return fs.readFileSync(where, 'utf8');
}

/** The dated, money-carrying rows of a CSV, by the header's own column names. */
function rowsOf(csv: string): { header: string[]; rows: Row[] } {
  const lines = csv.trim().split(/\r?\n/);
  const header = cells(lines[0]);

  const at = (name: string) => header.findIndex((h) => h.toLowerCase() === name);
  const date = at('date');
  const amount = at('amount');
  const balance = at('balance');
  expect(
    Math.min(date, amount, balance),
    `the header names no ${['date', 'amount', 'balance'][[date, amount, balance].indexOf(-1)]} column: ${header.join(', ')}`,
  ).toBeGreaterThanOrEqual(0);

  const rows = lines.slice(1).map((line) => {
    const field = cells(line);
    return {
      date: field[date],
      amount: Number(field[amount]),
      balance: Number(field[balance]),
    };
  });
  return { header, rows };
}

test.describe('bank-statement-to-csv: the statement it ships with', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('the example becomes rows, and the page says how many', async ({ page }) => {
    await convertTheExample(page);

    // The summary is the tool's own count; the preview is what it drew. They
    // are two different code paths over one answer, and a converter that
    // disagrees with itself about how many transactions it found has already
    // gone wrong somewhere the CSV will not show.
    const summary = (await page.locator('#summary').textContent()) ?? '';
    const claimed = Number(summary.match(/(\d+)\s+transaction/)?.[1]);
    expect(claimed, `no transaction count in the summary: ${summary}`).toBeGreaterThan(0);

    const drawn = await page.locator('#preview-body tr').count();
    const shown = Number((await page.locator('#preview-caption').textContent())?.match(/\d+/)?.[0]);
    expect(drawn, 'the preview drew a different number of rows than its caption claims')
      .toBe(shown);
  });

  test('the CSV it saves proves its own arithmetic', async ({ page }) => {
    await convertTheExample(page);
    const { header, rows } = rowsOf(await savedCsv(page));

    expect(rows.length, `the CSV has a header and nothing else: ${header.join(', ')}`)
      .toBeGreaterThan(1);

    // The claim the tool makes about itself, checked here rather than read off
    // the page. Every row's balance is the one above plus this row's amount;
    // a misread column, a dropped row or a wrapped description counted twice
    // all break it at the row where they happened.
    const broken: string[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      const expected = rows[i - 1].balance + rows[i].amount;
      // A tenth of a penny of tolerance, because these are decimal amounts
      // arriving through binary floating point and 4653.60 + 318.50 is not
      // exactly 4972.10 in either language.
      if (Math.abs(expected - rows[i].balance) > 0.001) {
        broken.push(
          `row ${i + 1}: ${rows[i - 1].balance} + ${rows[i].amount} = ${expected.toFixed(2)},`
          + ` but the file says ${rows[i].balance}`,
        );
      }
    }
    expect(broken, `\n${broken.join('\n')}\n`).toEqual([]);

    // And the page has to be saying so. A tool that reads a statement
    // correctly and then reports it as unproven is not wrong, but it is
    // useless: "not checked" is what it says when it cannot line the balance
    // up, and its own example is the one document it must never say that of.
    await expect(
      page.locator('#check-line'),
      'the tool could not verify a statement this file has just verified itself',
    ).toContainText(/adds up|balance/i);
  });

  test('every date and amount comes out in one shape', async ({ page }) => {
    await convertTheExample(page);
    const { rows } = rowsOf(await savedCsv(page));

    // What the result panel promises about the file: dates as YYYY-MM-DD and
    // amounts as plain signed numbers. A CSV whose dates are half one
    // convention and half another is the failure this tool exists to avoid -
    // 03/04/2026 is two different days, and a spreadsheet opening the file
    // will not ask which was meant.
    const odd = rows.filter((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date));
    expect(odd.map((row) => row.date), 'these dates are not YYYY-MM-DD').toEqual([]);

    const notNumbers = rows.filter((row) => !Number.isFinite(row.amount));
    expect(notNumbers.length, 'some amounts did not parse as plain numbers').toBe(0);
  });
});

test.describe('bank-statement-to-csv: what it refuses', () => {
  test('something that is not a PDF is refused, and said so', async ({ page }) => {
    await page.goto(URL_PATH);

    // A tool that quietly did nothing here would look exactly like one still
    // working, which is the failure worth guarding: the visitor has handed
    // over the wrong file and is waiting for a table.
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
      page.locator('#result-card'),
      'a file it refused still produced a table',
    ).toBeHidden();
  });
});
