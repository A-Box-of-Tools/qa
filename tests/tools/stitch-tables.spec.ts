import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { quiet, withoutThirdParties } from '../../lib/engine';
import { discoverTools } from '../../lib/tools';

/**
 * Tool-level functional tests for the table stitcher.
 *
 * A join fails quietly. What comes out still looks like a table: a heading row
 * has slipped into the data, two records that never belonged together sit on
 * one line, an amount has become text that no longer adds up. Nothing on the
 * page looks wrong, and the person it reaches has already stopped checking.
 *
 * So every expectation here is a table written out in this file and compared
 * with what the page exported, read back by a small CSV reader of this file's
 * own - not the page's summary of what it did. And a refusal or a piece of
 * detection is paired with a control showing the same input going the other
 * way, because "this was refused" means little if everything is.
 */

const URL_PATH = '/stitch-tables/';

const SHIPPED = discoverTools().includes('stitch-tables');
const NOT_YET = 'this site does not ship stitch-tables yet';

/** RFC 4180 and nothing cleverer: what a spreadsheet would make of the export. */
function readCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

async function read(page: Page, a: string, b: string): Promise<void> {
  await page.locator('#input-a').fill(a);
  await page.locator('#input-b').fill(b);
  await page.locator('#load').click();
  await expect(page.locator('#stitch')).toBeEnabled();
}

/** Stitch, and read the whole export back: the preview stops at 100 rows. */
async function stitched(page: Page): Promise<string[][]> {
  await page.locator('#stitch').click();
  await expect(page.locator('#download')).toBeVisible();
  return readCsv(await page.locator('#output').inputValue());
}

async function simpleMerge(page: Page, direction: 'append' | 'position' | 'both'): Promise<void> {
  await page.locator('input[name="mode"][value="simple"]').check();
  await page.locator('#simple-mode').selectOption(direction);
}

const file = (name: string, buffer: Buffer) => ({ name, mimeType: 'text/csv', buffer });

test.describe('stitch-tables: which rows meet', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await withoutThirdParties(page);
    await page.goto(URL_PATH);
  });

  test('the example joins on the pattern it says it uses', async ({ page }) => {
    await page.locator('#example').click();
    await expect(page.locator('#download')).toBeVisible();
    expect(readCsv(await page.locator('#output').inputValue())).toEqual([
      ['Invoice', 'Name', 'Amount', 'Reference', 'Team', 'Paid'],
      ['invoice-001', 'Ada', '15.00', 'paid/001', 'Green', 'yes'],
      ['invoice-002', 'Sam', '22.50', 'paid/002', 'Blue', 'yes'],
      ['invoice-003', 'Lee', '10.00', '', '', ''],
      ['', '', '', 'paid/004', 'Gold', 'no'],
    ]);
  });

  test('every combination of a repeated key is kept, and blank keys never match', async ({ page }) => {
    await read(page, 'k,a\nx,1\nx,2\ny,3\n,4\n', 'k,b\nx,10\nx,20\nx,30\nz,40\n,50\n');
    expect(await stitched(page)).toEqual([
      ['k (A)', 'a', 'k (B)', 'b'],
      ['x', '1', 'x', '10'], ['x', '1', 'x', '20'], ['x', '1', 'x', '30'],
      ['x', '2', 'x', '10'], ['x', '2', 'x', '20'], ['x', '2', 'x', '30'],
      ['y', '3', '', ''],
      ['', '4', '', ''],
      ['', '', 'z', '40'],
      ['', '', '', '50'],
    ]);
    await expect(page.locator('#duplicates')).toBeVisible();

    await page.locator('#join').selectOption('left');
    expect((await stitched(page)).at(-1), 'all of table A still kept a row only B has')
      .toEqual(['', '4', '', '']);

    await page.locator('#join').selectOption('inner');
    expect(await stitched(page), 'matching pairs only kept an unpaired row').toHaveLength(7);
  });

  test('the match starts on a column both tables name', async ({ page }) => {
    // The shared column is not first in table A. Matching first column to first
    // column here would pair nothing, and it would look like a finished result.
    await read(page, 'name,id\nAda,1\nBo,2\n', 'id,email\n2,bo@x.io\n1,ada@x.io\n');
    await expect(page.locator('#key-a')).toHaveValue('1');
    await expect(page.locator('#key-b')).toHaveValue('0');
    expect(await stitched(page)).toEqual([
      ['name', 'id (A)', 'id (B)', 'email'],
      ['Ada', '1', '1', 'ada@x.io'],
      ['Bo', '2', '2', 'bo@x.io'],
    ]);

    // Control: with no shared heading there is nothing to infer from.
    await read(page, 'Invoice,Name\n1,Ada\n', 'Reference,Team\n1,Blue\n');
    await expect(page.locator('#key-a')).toHaveValue('0');
    await expect(page.locator('#key-b')).toHaveValue('0');
  });

  test('a manual pair joins those two rows only, and can be taken back', async ({ page }) => {
    await read(page, 'id,a\n1,x\n2,y\n3,z\n', 'id,b\n7,p\n8,q\n9,r\n');
    await page.locator('input[name="mode"][value="manual"]').check();
    await page.locator('#row-a').selectOption('2');
    await page.locator('#row-b').selectOption('0');
    await page.locator('#add-pair').click();

    await expect(page.locator('#row-a option[value="2"]'), 'a paired row was offered again').toHaveCount(0);
    expect(await stitched(page)).toEqual([
      ['id (A)', 'a', 'id (B)', 'b'],
      ['1', 'x', '', ''],
      ['2', 'y', '', ''],
      ['3', 'z', '7', 'p'],
      ['', '', '8', 'q'],
      ['', '', '9', 'r'],
    ]);

    await page.locator('#pairs button').click();
    await expect(page.locator('#row-a option[value="2"]'), 'a released row did not come back').toHaveCount(1);
    await expect(page.locator('#download'), 'the export outlived the pair it was made from').toBeHidden();
    await expect(page.locator('#add-pair'), 'removing the pair dropped keyboard focus').toBeFocused();
  });

  test('accents match however they were stored, and marks stay part of the word', async ({ page }) => {
    await read(page, 'name,age\nJos\u00e9,30\n', 'name,city\nJose\u0301,Lima\n');
    expect(await stitched(page), 'the same name in two Unicode forms did not match, or a cell was rewritten').toEqual([
      ['name (A)', 'age', 'name (B)', 'city'],
      ['Jos\u00e9', '30', 'Jose\u0301', 'Lima'],
    ]);

    // Control: in Hindi the marks are the vowels, and removing them with the
    // punctuation made two different words into one key.
    await read(page, 'name,age\nकिताब,30\n', 'name,city\nकताब,Lima\n');
    await page.locator('#pattern').selectOption('letters-digits');
    expect(await stitched(page), 'two different words were treated as one key').toEqual([
      ['name (A)', 'age', 'name (B)', 'city'],
      ['किताब', '30', '', ''],
      ['', '', 'कताब', 'Lima'],
    ]);
  });
});

test.describe('stitch-tables: reading a table', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await withoutThirdParties(page);
    await page.goto(URL_PATH);
  });

  test('an ordinary heading row is read as headings, and can be overruled', async ({ page }) => {
    await read(page, 'Name,Department\nAda,Finance\nBo,Sales\n', 'Name,City\nAda,Toronto\nCy,Oslo\n');
    expect(await stitched(page)).toEqual([
      ['Name (A)', 'Department', 'Name (B)', 'City'],
      ['Ada', 'Finance', 'Ada', 'Toronto'],
      ['Bo', 'Sales', '', ''],
      ['', '', 'Cy', 'Oslo'],
    ]);

    // Control: told there are no headings, those rows really are data. This is
    // what the first answer would have looked like had detection missed them.
    await page.locator('#header-a').selectOption('absent');
    await page.locator('#header-b').selectOption('absent');
    await page.locator('#load').click();
    await expect(page.locator('#stitch')).toBeEnabled();
    expect((await stitched(page)).slice(1)).toContainEqual(['Name', 'Department', 'Name', 'City']);
  });

  for (const [language, source] of [
    ['Chinese', '姓名,邮箱\n张三,a@example.com\n李四,b@example.com\n'],
    ['German', 'Name,E-Mail,Stadt\nAda,a@example.com,Berlin\nBo,b@example.com,Köln\n'],
    ['Spanish', 'Nombre,Ciudad\nAda,Lima\nBo,Quito\n'],
    ['French', 'Prénom,Ville\nAda,Paris\nBo,Lyon\n'],
    ['Portuguese', 'Nome,Cidade\nAda,Lima\nBo,Recife\n'],
    ['Japanese', '名前,住所\n山田,東京\n佐藤,大阪\n'],
  ] as const) {
    test(`a ${language} heading row is recognised`, async ({ page }) => {
      await read(page, source, source);
      await expect(page.locator('#status-a')).toContainText('Rows: 2');
    });
  }

  test('a first row of data is not taken for headings', async ({ page }) => {
    for (const source of ['Ada,Finance\nBo,Sales\n', 'New York City,United States\nParis,France\n',
      '华为技术有限公司,深圳\n腾讯公司,北京\n']) {
      await read(page, source, source);
      await expect(page.locator('#status-a'), `lost a row of: ${source}`).toContainText('Rows: 2');
    }
  });

  test('a quote mark in a spreadsheet paste is that cell\'s text', async ({ page }) => {
    await read(page, 'SKU\tProduct\nA1\t5" screen\nA2\t"big" one\n', 'SKU\tPrice\nA1\t10\nA2\t3\n');
    expect(await stitched(page)).toEqual([
      ['SKU (A)', 'Product', 'SKU (B)', 'Price'],
      ['A1', '5" screen', 'A1', '10'],
      ['A2', '"big" one', 'A2', '3'],
    ]);
  });

  test('real CSV quoting is honoured, and quoting that contradicts itself is refused', async ({ page }) => {
    await read(page, 'id,note\n1,"a,b"\n2,"say ""hi"""\n3,"two\nlines"\n', 'id,team\n1,p\n');
    expect((await stitched(page)).map((row) => row[1])).toEqual(['note', 'a,b', 'say "hi"', 'two\nlines']);

    await page.locator('#input-a').fill('id,note\n1,"closed"tail\n');
    await page.locator('#load').click();
    await expect(page.locator('#input-error')).toBeVisible();
    await expect(page.locator('#stitch')).toBeDisabled();
  });

  test('a file in another encoding is refused, and the fixed file can be picked again', async ({ page }) => {
    const source = 'id,name\n1,Müller\n';
    const pick = page.locator('#file-a');

    await pick.setInputFiles(file('a.csv', Buffer.from(source, 'latin1')));
    await expect(page.locator('#input-error')).toBeVisible();
    await expect(page.locator('#input-a')).toHaveValue('');
    // A browser fires no change for the path an input already holds, so an input
    // that kept the refused file would ignore the visitor's next attempt.
    await expect.poll(() => pick.evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);

    await pick.setInputFiles(file('a.csv', Buffer.from(source, 'utf8')));
    await expect(page.locator('#input-a')).toHaveValue(source);
    await expect(page.locator('#input-error')).toBeHidden();

    // Both boxes full: nothing is left to wait for, so it reads without being asked.
    await page.locator('#file-b').setInputFiles(file('b.csv', Buffer.from('id,team\n1,Blue\n', 'utf8')));
    await expect(page.locator('#stitch')).toBeEnabled();
    await expect(page.locator('#status-a')).toContainText('Rows: 1');
  });

  test('a file marked as UTF-16 is read as what it says it is', async ({ page }) => {
    const source = 'id\tteam\n1\tGrün\n';
    await page.locator('#file-a').setInputFiles(
      file('a.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])),
    );
    await expect(page.locator('#input-a')).toHaveValue(source);
  });

  test('a dropped file reaches a table and does not replace the page', async ({ page }) => {
    const drop = (selector: string, files: Array<[string, string]>) => page.evaluate(
      ({ selector, files }) => {
        const data = new DataTransfer();
        for (const [name, text] of files) data.items.add(new File([text], name, { type: 'text/csv' }));
        const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
        document.querySelector(selector)!.dispatchEvent(event);
        return { kept: event.defaultPrevented, files: data.files.length };
      },
      { selector, files },
    );

    const one = await drop('#input-b', [['b.csv', 'id,x\n1,2\n']]);
    test.skip(one.files === 0, 'this engine builds a drag with no files in it');
    expect(one.kept, 'the browser would have opened the file in place of the page').toBe(true);
    await expect(page.locator('#input-b')).toHaveValue('id,x\n1,2\n');
    await expect(page.locator('#input-a')).toHaveValue('');

    expect((await drop('h1', [['a.csv', 'id,y\n1,3\n']])).kept).toBe(true);
    await expect(page.locator('#input-a'), 'a drop beside the tables did not find the empty one')
      .toHaveValue('id,y\n1,3\n');

    expect((await drop('body', [['p.csv', 'id,p\n1,4\n'], ['q.csv', 'id,q\n1,5\n']])).kept).toBe(true);
    await expect(page.locator('#input-a')).toHaveValue('id,p\n1,4\n');
    await expect(page.locator('#input-b')).toHaveValue('id,q\n1,5\n');
    await expect(page.locator('#stitch')).toBeEnabled();
  });
});

test.describe('stitch-tables: the merge directions', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await withoutThirdParties(page);
    await page.goto(URL_PATH);
  });

  test('adding rows aligns columns by name and keeps the extra ones', async ({ page }) => {
    await read(page, 'id,name\n1,Ada\n2,Bo\n', 'email,id\nbo@x.io,2\ncy@x.io,3\n');
    await simpleMerge(page, 'append');
    expect(await stitched(page)).toEqual([
      ['id', 'name', 'email'],
      ['1', 'Ada', ''],
      ['2', 'Bo', ''],
      ['2', '', 'bo@x.io'],
      ['3', '', 'cy@x.io'],
    ]);
  });

  test('adding columns keeps every row of the longer table', async ({ page }) => {
    await read(page, 'id,name\n1,Ada\n', 'score,team\n10,North\n20,West\n');
    await simpleMerge(page, 'position');
    expect(await stitched(page)).toEqual([
      ['id', 'name', 'score', 'team'],
      ['1', 'Ada', '10', 'North'],
      ['', '', '20', 'West'],
    ]);
  });

  test('both directions combine shared fields, and a disagreement keeps both columns', async ({ page }) => {
    await read(page, 'id,name\n1,Ada\n2,Bo\n', 'id,email\n2,bo@x.io\n3,cy@x.io\n');
    await simpleMerge(page, 'both');
    expect(await stitched(page)).toEqual([
      ['id', 'name', 'email'],
      ['1', 'Ada', ''],
      ['2', 'Bo', 'bo@x.io'],
      ['3', '', 'cy@x.io'],
    ]);
    await expect(page.locator('#conflicts')).toBeHidden();

    await read(page, 'id,name\n1,Ada\n', 'id,name\n1,Adele\n');
    expect(await stitched(page), 'one of two disagreeing values was silently dropped').toEqual([
      ['id', 'name (A)', 'name (B)'],
      ['1', 'Ada', 'Adele'],
    ]);
    await expect(page.locator('#conflicts')).toBeVisible();
  });
});

test.describe('stitch-tables: what leaves the page', () => {
  test.skip(!SHIPPED, NOT_YET);

  test.beforeEach(async ({ page }) => {
    await withoutThirdParties(page);
    await page.goto(URL_PATH);
  });

  test('a number stays a number, and a formula is defused unless asked otherwise', async ({ page }) => {
    await read(page,
      'id,amount,phone,risky,also\n1,-12.50,+1 555 010 1234,=1+1,-SUM(A1)\n2,7.00,,@cmd,+A1\n',
      'id,note\n1,refund\n2,sale\n');
    expect(await stitched(page)).toEqual([
      ['id (A)', 'amount', 'phone', 'risky', 'also', 'id (B)', 'note'],
      ['1', '-12.50', '+1 555 010 1234', "'=1+1", "'-SUM(A1)", '1', 'refund'],
      ['2', '7.00', '', "'@cmd", "'+A1", '2', 'sale'],
    ]);

    await page.locator('#protect').uncheck();
    expect(readCsv(await page.locator('#output').inputValue())[1]).toEqual(
      ['1', '-12.50', '+1 555 010 1234', '=1+1', '-SUM(A1)', '1', 'refund'],
    );
  });

  test('the downloaded file is the export, marked UTF-8, in either format', async ({ page }) => {
    const expected = [['id (A)', 'note', 'id (B)', 'city'], ['1', 'Ünï, "code"', '1', 'Köln']];
    await read(page, 'id,note\n1,"Ünï, ""code"""\n', 'id,city\n1,Köln\n');
    await stitched(page);

    const saved = async () => {
      const pending = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await pending;
      return { name: download.suggestedFilename(), bytes: fs.readFileSync((await download.path())!) };
    };

    const csv = await saved();
    expect(csv.name).toBe('stitched-table.csv');
    expect([...csv.bytes.subarray(0, 3)], 'a spreadsheet needs the mark to read this as UTF-8')
      .toEqual([0xef, 0xbb, 0xbf]);
    expect(readCsv(csv.bytes.subarray(3).toString('utf8'))).toEqual(expected);

    await page.locator('#output-delimiter').selectOption('tab');
    const tsv = await saved();
    expect(tsv.name).toBe('stitched-table.tsv');
    expect(readCsv(tsv.bytes.subarray(3).toString('utf8'), '\t')).toEqual(expected);
  });

  test('a line ending inside a picked file\'s cell reaches the download unchanged', async ({ page }) => {
    // A textarea turns CRLF into LF, so this only survives if the page kept the
    // source it read rather than what the box now shows.
    await page.locator('#file-a').setInputFiles(file('a.csv', Buffer.from('id,note\r\n1,"first\r\nsecond"\r\n')));
    await page.locator('#file-b').setInputFiles(file('b.csv', Buffer.from('id,x\r\n1,y\r\n')));
    await expect(page.locator('#stitch')).toBeEnabled();
    await stitched(page);

    const pending = page.waitForEvent('download');
    await page.locator('#download').click();
    const bytes = fs.readFileSync((await (await pending).path())!);
    expect(readCsv(bytes.subarray(3).toString('utf8'))[1][1]).toBe('first\r\nsecond');
  });

  test('editing retires the export before it can be mistaken for the new tables', async ({ page }) => {
    await read(page, 'id,a\n1,x\n', 'id,b\n1,y\n');
    await stitched(page);

    await page.locator('#input-a').fill('id,a\n2,x\n');
    await expect(page.locator('#download')).toBeHidden();
    await expect(page.locator('#output')).toHaveValue('');
    await expect(page.locator('#stitch')).toBeDisabled();
  });

  test('a result too large to hold is refused rather than half built', async ({ page }) => {
    // The default thirty seconds is too little for WebKit here, and the time
    // is the engine's own, not the page's. Alone on a CI runner it takes two
    // seconds to paste the 1.9 million character cell, each time, and one to
    // three for every click made while that cell is in a box, since a click
    // waits for drawn frames and it draws this page slowly. That comes to 16
    // seconds alone and to more than thirty beside three busy workers, where
    // this case kept timing out with every assertion it had reached passing.
    // In those traces the refusal took the page 16 to 125 milliseconds. Each
    // assertion below keeps its own five seconds.
    test.setTimeout(90_000);

    // Two hundred rows on each side sharing one key is forty thousand pairs.
    const many = (column: string) => `key,${column}\n${Array(200).fill('x,1').join('\n')}\n`;
    await read(page, many('a'), many('b'));
    await page.locator('#stitch').click();
    await expect(page.locator('#stitch-error')).toBeVisible();
    await expect(page.locator('#download')).toBeHidden();
    await expect(page.locator('#output')).toHaveValue('');

    // Few rows, one long cell: rows and cells alone would pass this, and it used
    // to arrive in the page as a frozen tab rather than as an error.
    const long = `id,note\nx,${'y'.repeat(1_900_000)}\n`;
    await read(page, long, `id,other\n${Array.from({ length: 100 }, (_, i) => `x,${i}`).join('\n')}\n`);
    await page.locator('#stitch').click();
    await expect(page.locator('#stitch-error')).toBeVisible();

    // Control: the same cell once is a result like any other.
    await read(page, long, 'id,team\nx,1\n');
    expect(await stitched(page)).toHaveLength(2);
  });

  test('neither table ever appears in a request', async ({ page }) => {
    // Together these two can say more than either does alone, and a join is
    // exactly the moment a page might be tempted to ask a server for help.
    const traffic: string[] = [];
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const left = 'QAcanaryLEFT9f3e71dNotForSending';
    const right = 'QAcanaryRIGHT4a2c88eNotForSending';
    await read(page, `id,secret\n1,${left}\n`, `id,secret\n1,${right}\n`);
    await stitched(page);
    await quiet(page);

    for (const entry of traffic) {
      expect(entry, 'table A was sent').not.toContain(left);
      expect(entry, 'table B was sent').not.toContain(right);
    }
  });

  test('a note in the fold is named after its field, not its menu', async ({ page }) => {
    // The build names a gathered note after the label before it, and a label
    // wrapping a menu used to contribute every option: "Rows to keepAll rows...".
    const fold = page.locator('#setup details.card-note');
    await expect(fold.locator('strong').filter({ hasText: 'Rows to keep' })).toHaveText('Rows to keep');
    await expect(fold).not.toContainText('All rows from both tables');
  });
});
