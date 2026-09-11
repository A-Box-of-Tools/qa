import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the PDF-to-CSV converter.
 *
 * It lives at /bank-statement-to-csv/ and was a bank statement converter when
 * this file was written. Since website#416 it finds every table in a PDF -
 * statements, invoices, price lists, reports - and keeps every row of each,
 * under the name PDF to CSV; the slug did not move, so neither did this file.
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
 * counted as its own row, that chain breaks at the row it happened on - which
 * is exactly why the tool uses it, and exactly why an independent copy of it
 * is worth having.
 *
 * THE FIXTURE IS THE TOOL'S OWN EXAMPLE
 *
 * `#example-button` builds a three-page statement in the page, written as a
 * ledger - signed amounts and a running balance - so that there is something
 * to prove. Using it rather than a PDF built here is deliberate twice over:
 * the example is what a first-time visitor presses, so it is worth knowing it
 * works, and a document written by this repository would only prove the tool
 * can read documents shaped the way its tests expect. What is checked is not
 * the example's contents - those are the site's to change - but that
 * whatever it contains comes out internally consistent.
 *
 * AGAINST THE TOOL FROM BEFORE #416 AND AFTER IT
 *
 * Production runs this file every night against whatever version is released,
 * and every preview runs it against whatever version that pull request
 * carries, so for as long as #416 is on `dev` both are being tested at once.
 * Nothing here names a selector or a sentence only one of them has. The
 * multi-table tool captions each table it draws under #previews; the one
 * before it had a single #preview-caption; both say "N rows" in it, and both
 * write a CSV that the reader below takes as a list of tables of which the
 * older tool's is always a list of one.
 */

const URL_PATH = '/bank-statement-to-csv/';

/**
 * Whether the site under test has this tool at all.
 *
 * The tool and its spec live in different repositories, so they cannot land
 * in one change: this file was written against a tool that was on the
 * website's `dev` and not yet in a release. Run against production before
 * that release landed, every case below would have failed on a 404 that says
 * nothing about the tool. Asked of the checkout the run was given, the same
 * way the rest of the suite discovers what to test.
 */
const SHIPPED = discoverTools().includes('bank-statement-to-csv');
const NOT_YET = 'this site does not ship bank-statement-to-csv yet';

/** One row of a table with a running balance, as far as this file cares. */
interface Row {
  date: string;
  amount: number;
  balance: number;
}

/** A table as the CSV holds it: its own heading row, then its rows. */
interface Table {
  header: string[];
  rows: string[][];
}

const LINE_FEED = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * Every record in a CSV, as fields.
 *
 * A parser over the whole text rather than one line at a time, because RFC
 * 4180 lets a quoted field carry a line break - a wrapped description is
 * exactly that - and splitting on newlines first would cut such a row in two
 * and report a correct file as broken. Quotes are handled for the same
 * reason: a description with a comma in it is where a naive split goes wrong.
 */
function records(csv: string): string[][] {
  const text = csv.startsWith(BYTE_ORDER_MARK) ? csv.slice(1) : csv;
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === LINE_FEED || ch === CARRIAGE_RETURN) {
      if (ch === CARRIAGE_RETURN && text[i + 1] === LINE_FEED) i += 1;
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/**
 * The tables in a CSV this tool wrote.
 *
 * Since website#416 the converter writes every table it found one after
 * another, each under its own heading row, with an empty line between: the
 * shape a spreadsheet opens as blocks. A file holding one table is simply the
 * case with no empty line in it, so this reads the tool from before that
 * change and after it the same way.
 *
 * An empty line is a record of one empty field. A row whose cells are all
 * empty is still several fields, so it is never mistaken for the gap between
 * two tables.
 */
function tablesOf(csv: string): Table[] {
  const tables: Table[] = [];
  let block: string[][] = [];
  const close = () => {
    if (block.length) tables.push({ header: block[0], rows: block.slice(1) });
    block = [];
  };
  for (const record of records(csv)) {
    if (record.length === 1 && record[0] === '') close();
    else block.push(record);
  }
  close();
  return tables;
}

/**
 * The tables that carry a running balance, as dated, money-carrying rows.
 *
 * Found by each heading row's own column names. Most tables in a PDF have no
 * balance - a price list, a summary of charges - and there is nothing in them
 * to add up, so they are left out here rather than failed: the arithmetic
 * below is a claim about ledgers, and only the tables that are ledgers can
 * be held to it.
 */
function ledgersOf(csv: string): { header: string[]; rows: Row[] }[] {
  return tablesOf(csv).flatMap(({ header, rows }) => {
    const at = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
    const date = at('date');
    const amount = at('amount');
    const balance = at('balance');
    if (Math.min(date, amount, balance) < 0) return [];
    return [{
      header,
      rows: rows.map((field) => ({
        date: field[date],
        amount: Number(field[amount]),
        balance: Number(field[balance]),
      })),
    }];
  });
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

test.describe('bank-statement-to-csv: the statement it ships with', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await page.goto(URL_PATH);
  });

  test('the example becomes rows, and the page says how many', async ({ page }) => {
    await convertTheExample(page);

    // Every table the page draws is captioned with how many rows it has, and
    // the file is where those rows actually go. Two code paths over one
    // answer: a converter that tells you it found fifteen rows and hands you
    // fourteen has lost one somewhere neither the preview nor the download
    // would show on its own.
    //
    // By the captions rather than the summary sentence above them, which this
    // first read and which then broke on nothing more than a change of words:
    // "15 transactions" became "One table, 15 rows" when #416 taught the tool
    // to find every table in a PDF. A caption states one table's count and
    // nothing else, and says it the same way before that change and after.
    const captions = await page.locator('#previews caption, #preview-caption').allTextContents();
    expect(captions.length, 'the page drew no table at all').toBeGreaterThan(0);

    const claimed = captions.map((text) => Number(text.match(/(\d+)\s+rows?\b/)?.[1]));
    expect(
      captions.filter((_, at) => !Number.isFinite(claimed[at])),
      'a table whose caption does not say how many rows it has',
    ).toEqual([]);

    // One block in the file per table on the page, in the same order, each
    // holding the rows its caption promised.
    const tables = tablesOf(await savedCsv(page));
    expect(
      tables.map((table) => table.rows.length),
      `the captions promise ${claimed.join(', ')} rows and the file holds `
      + `${tables.map((table) => table.rows.length).join(', ')}`,
    ).toEqual(claimed);

    // And the preview draws at most what was claimed: it stops after a few
    // dozen rows of each table, and the download does not.
    const drawn = await page.locator('#previews tbody tr, #preview-body tr').count();
    expect(drawn, 'the page claims rows and drew none of them').toBeGreaterThan(0);
    expect(drawn, 'the preview drew more rows than the captions say exist')
      .toBeLessThanOrEqual(claimed.reduce((sum, n) => sum + n, 0));
  });

  test('the CSV it saves proves its own arithmetic', async ({ page }) => {
    await convertTheExample(page);
    const ledgers = ledgersOf(await savedCsv(page));

    // The example is written as a ledger precisely so that there is something
    // to prove. A file with no table carrying a balance has lost the one
    // thing that makes it checkable.
    expect(ledgers.length, 'no table in the example carries a running balance')
      .toBeGreaterThan(0);

    // The claim the tool makes about itself, checked here rather than read off
    // the page. Every row's balance is the one above plus this row's amount;
    // a misread column, a dropped row or a wrapped description counted twice
    // all break it at the row where they happened. Per table, because two
    // tables' balances have nothing to do with one another.
    const broken: string[] = [];
    ledgers.forEach(({ rows }, n) => {
      expect(rows.length, `table ${n + 1} has a heading and nothing else`).toBeGreaterThan(1);
      for (let i = 1; i < rows.length; i += 1) {
        const expected = rows[i - 1].balance + rows[i].amount;
        // A tenth of a penny of tolerance, because these are decimal amounts
        // arriving through binary floating point and 4653.60 + 318.50 is not
        // exactly 4972.10 in either language.
        if (Math.abs(expected - rows[i].balance) > 0.001) {
          broken.push(
            `table ${n + 1}, row ${i + 1}: ${rows[i - 1].balance} + ${rows[i].amount}`
            + ` = ${expected.toFixed(2)}, but the file says ${rows[i].balance}`,
          );
        }
      }
    });
    expect(broken, broken.join(LINE_FEED)).toEqual([]);

    // And the page has to be saying so. A tool that reads a ledger correctly
    // and then reports it as unproven is not wrong, but it is useless: "not
    // checked" is what it says when it cannot line the balance up, and its
    // own example is the one document it must never say that of.
    await expect(
      page.locator('#check-line'),
      'the tool could not verify a ledger this file has just verified itself',
    ).toContainText(/adds up|balance/i);
  });

  test('every date and amount comes out in one shape', async ({ page }) => {
    await convertTheExample(page);
    const rows = ledgersOf(await savedCsv(page)).flatMap((ledger) => ledger.rows);
    expect(rows.length, 'no table in the example carries a running balance').toBeGreaterThan(0);

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
  test.skip(!SHIPPED, NOT_YET);

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
