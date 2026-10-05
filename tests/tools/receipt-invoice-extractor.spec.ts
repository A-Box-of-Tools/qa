import fs from 'node:fs';
import { test, expect, type Page, type Locator } from '@playwright/test';
import { decodedPixels, pixelAt } from '../../lib/browser-image';
import { zipEntries } from '../../lib/zip';

/**
 * The examples are actual locally drawn pictures, not prefilled form fields.
 * They exercise the OCR and image preparation before the visitor's corrections.
 * These cases cover that clean control and the reviewed export workflow; they
 * do not claim that a receipt detector reads every real camera photograph.
 *
 * The amounts used after correction deliberately need individual rounding:
 * 12.31 / 2 is 6.16 and 4.21 / 2 is 2.11, so their sum must be 8.27 rather
 * than rounding the combined unrounded amount to 8.26. The saved MIME and ZIP
 * bytes are read independently here rather than asking the tool to parse them.
 */
const URL_PATH = '/receipt-invoice-extractor/';
const documents = (page: Page) => page.locator('#documents .document');
const field = (document: Locator, name: string) => document.locator(`[data-field="${name}"]`);

async function loadExamples(page: Page): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#example-button').click();
  await expect(documents(page)).toHaveCount(2, { timeout: 60_000 });
  // Confirmation is disabled until both reading and JPEG preparation finish.
  for (const document of await documents(page).all()) {
    await expect(field(document, 'confirmed')).toBeEnabled({ timeout: 180_000 });
    await expect(document.locator('.download-picture')).toBeEnabled();
  }
  await expect(page.locator('#stop-reading')).toBeHidden();
  await expect(page.locator('#load-error')).toBeHidden();
}

async function correctDocuments(page: Page): Promise<void> {
  const first = documents(page).nth(0);
  const second = documents(page).nth(1);
  await page.locator('#final-currency-choice').selectOption('EUR');
  for (const [document, merchant, date, reference, currency, amount] of [
    [first, 'QA Cafe', '2026-09-26', 'QA-001', 'CAD', '12.31'],
    [second, 'QA Supplies', '2026-10-04', 'QA-002', 'USD', '4.21'],
  ] as const) {
    await field(document, 'merchant').fill(merchant);
    await field(document, 'date').fill(date);
    await field(document, 'reference').fill(reference);
    await document.locator('[data-currency-choice]').selectOption(currency);
    await field(document, 'amount').fill(amount);
    await field(document, 'rate').fill('0.5');
  }
}

async function confirmAll(page: Page): Promise<void> {
  for (const document of await documents(page).all()) {
    await expect(field(document, 'confirmed')).toBeEnabled({ timeout: 60_000 });
    await field(document, 'confirmed').check();
    await expect(field(document, 'confirmed')).toBeChecked();
  }
  await expect(page.locator('#download-email')).toBeEnabled();
}

async function download(page: Page, button: Locator): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await button.click();
  const saved = await pending;
  const location = await saved.path();
  expect(location, 'the browser did not save the export').toBeTruthy();
  return fs.readFileSync(location!);
}

function readEmail(bytes: Buffer): {
  headers: string;
  subject: string;
  parts: Array<{ headers: string; type: string; filename: string; bytes: Buffer }>;
} {
  const raw = bytes.toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  expect(split, 'the email has no header/body separator').toBeGreaterThan(0);
  const headers = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const boundary = /boundary="([^"]+)"/i.exec(headers)?.[1];
  expect(boundary, 'the email is not a MIME multipart message').toBeTruthy();
  const encodedSubject = /^Subject: (.*)$/mi.exec(headers)?.[1] ?? '';
  const subject = Array.from(encodedSubject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/gi))
    .map((match) => Buffer.from(match[1], 'base64').toString('utf8')).join('');
  const parts = raw.slice(split + 4).split(`--${boundary}`).slice(1, -1).map((part) => {
    const clean = part.replace(/^\r\n/, '');
    const separator = clean.indexOf('\r\n\r\n');
    expect(separator, 'a MIME part has no header/body separator').toBeGreaterThan(0);
    const partHeaders = clean.slice(0, separator).replace(/\r\n[ \t]+/g, ' ');
    expect(partHeaders).toMatch(/^Content-Transfer-Encoding: base64$/mi);
    return {
      headers: partHeaders,
      type: /^Content-Type: ([^;\r\n]+)/mi.exec(partHeaders)?.[1] ?? '',
      filename: /filename="([^"]+)"/i.exec(partHeaders)?.[1] ?? '',
      bytes: Buffer.from(clean.slice(separator + 4).replace(/\s/g, ''), 'base64'),
    };
  });
  return { headers, subject, parts };
}

/** Read whole CSV records, including quoted commas, quotes and line breaks. */
function readCsv(csv: string): string[][] {
  const text = csv.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character !== '"') value += character;
      else if (text[at + 1] === '"') { value += '"'; at += 1; }
      else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(value); value = ''; }
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[at + 1] === '\n') at += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  expect(quoted, 'the saved CSV ended inside a quoted field').toBe(false);
  if (value !== '' || row.length) rows.push([...row, value]);
  return rows;
}

test.describe('receipt-invoice-extractor: reading, review and attached exports', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000);
    await loadExamples(page);
  });

  test('the pictures suggest their totals and currency before manual corrections', async ({ page }) => {
    await expect(field(documents(page).nth(0), 'amount')).toHaveValue('24.30');
    await expect(field(documents(page).nth(1), 'amount')).toHaveValue('45.20');
    for (const document of await documents(page).all()) {
      await expect(document.locator('[data-currency-choice]')).toHaveValue('CAD');
      await expect(field(document, 'confirmed')).not.toBeChecked();
      await expect(document.locator('.ocr-text')).not.toHaveValue('');
    }
    await expect(page.locator('#checked-count')).toHaveText('0');
    await expect(page.locator('#email-report')).toBeDisabled();
    await expect(page.locator('#download-email')).toBeDisabled();
    await expect(page.locator('#email-subject')).toHaveValue(/2 documents$/);
    await confirmAll(page);
    await expect(page.locator('#grand-total')).toHaveText('69.50 CAD');
    await expect(page.locator('#email-subject')).toHaveValue(/2 documents — CAD 69\.50$/);
  });

  test('only reviewed amounts contribute, and editing a rate retires the email approval', async ({ page }) => {
    await correctDocuments(page);
    const first = documents(page).nth(0);
    const second = documents(page).nth(1);
    await field(first, 'confirmed').check();
    await expect(page.locator('#checked-count')).toHaveText('1');
    await expect(page.locator('#review-count')).toHaveText('1');
    await expect(page.locator('#grand-total')).toHaveText('6.16 EUR');
    await expect(page.locator('#download-email')).toBeDisabled();
    await expect(page.locator('#download-images')).toBeDisabled();
    await expect(page.locator('#email-subject')).toHaveValue(/2 documents$/);

    await field(second, 'confirmed').check();
    await expect(page.locator('#grand-total')).toHaveText('8.27 EUR');
    await expect(page.locator('#report-text')).toHaveValue(/Grand total: 8\.27 EUR across 2 checked documents/);
    await expect(page.locator('#email-subject')).toHaveValue(/2 documents — EUR 8\.27$/);
    await expect(page.locator('#email-report')).toBeEnabled();

    await field(second, 'rate').fill('0.75');
    await expect(field(second, 'confirmed')).not.toBeChecked();
    await expect(page.locator('#checked-count')).toHaveText('1');
    await expect(page.locator('#grand-total')).toHaveText('6.16 EUR');
    await expect(page.locator('#email-report')).toBeDisabled();
    await expect(page.locator('#download-email')).toBeDisabled();
    await expect(page.locator('#email-subject')).toHaveValue(/2 documents$/);
    await field(second, 'confirmed').check();
    await expect(page.locator('#grand-total')).toHaveText('9.32 EUR');
    await expect(page.locator('#email-subject')).toHaveValue(/2 documents — EUR 9\.32$/);

    await page.locator('#email-subject').fill('Reviewed October expenses');
    await field(second, 'amount').fill('4.22');
    await field(second, 'confirmed').check();
    await expect(page.locator('#grand-total')).toHaveText('9.33 EUR');
    await expect(page.locator('#email-subject')).toHaveValue('Reviewed October expenses');
  });

  test('the most used currency and first-in-a-tie rule reset an explicit final choice', async ({ page }) => {
    const first = documents(page).nth(0);
    const second = documents(page).nth(1);
    await expect(page.locator('#final-currency-choice')).toHaveValue('CAD');
    await page.locator('#final-currency-choice').selectOption('EUR');
    await first.locator('[data-currency-choice]').selectOption('USD');
    await expect(page.locator('#final-currency-choice')).toHaveValue('EUR');
    await page.locator('#default-currency-help summary').click();
    await expect(page.locator('#default-currency-note')).toBeVisible();
    await expect(page.locator('#final-currency-choice')).toHaveValue('EUR');
    // Adding the two CAD examples again makes CAD the majority even though
    // the first document is USD; an implementation that always picked first
    // would otherwise pass every two-document tie check below.
    await page.locator('#example-button').click();
    await expect(documents(page)).toHaveCount(4, { timeout: 60_000 });
    for (const document of await documents(page).all()) {
      await expect(field(document, 'confirmed')).toBeEnabled({ timeout: 180_000 });
    }
    await expect(page.locator('#final-currency-choice')).toHaveValue('EUR');
    await page.locator('#use-default-currency').click();
    await expect(page.locator('#final-currency-choice')).toHaveValue('CAD');
    await documents(page).nth(3).locator('.remove-document').click();
    await documents(page).nth(2).locator('.remove-document').click();
    await expect(page.locator('#final-currency-choice')).toHaveValue('USD');

    await second.locator('[data-currency-choice]').selectOption('USD');
    await expect(page.locator('#final-currency-choice')).toHaveValue('USD');
    await first.locator('[data-currency-choice]').selectOption('CAD');
    await expect(page.locator('#final-currency-choice')).toHaveValue('CAD');
    for (const document of await documents(page).all()) {
      await expect(document.locator('[data-final-currency-choice]')).toHaveValue('CAD');
    }
    await first.locator('.remove-document').click();
    await expect(page.locator('#final-currency-choice')).toHaveValue('USD');
    await expect(page.locator('#document-count')).toHaveText('1');
    await expect(page.locator('#email-subject')).toHaveValue(/1 documents?$/);
    await page.locator('#clear-all').click();
    await expect(documents(page)).toHaveCount(0);
    await expect(page.locator('#document-count')).toHaveText('0');
    await expect(page.locator('#download-email')).toBeDisabled();
  });

  test('email and ZIP contain the reviewed report and the exact cropped JPEG copies', async ({ page }) => {
    await correctDocuments(page);
    await confirmAll(page);
    const crops = [
      { x: 100, y: 100, width: 800, height: 500 },
      { x: 120, y: 100, width: 760, height: 480 },
    ];
    const pictures: Buffer[] = [];
    for (const [index, crop] of crops.entries()) {
      const document = documents(page).nth(index);
      await document.locator('.crop-editor > summary').click();
      // Reduce the dimensions before moving the origin: the cropper clamps
      // coordinates against the current size, so x/y first would test a
      // different rectangle from the one requested here.
      for (const name of ['width', 'height', 'x', 'y'] as const) {
        await document.locator(`[data-crop="${name}"]`).fill(String(crop[name]));
      }
      await document.locator('[data-crop="y"]').press('Tab');
      for (const [name, value] of Object.entries(crop)) {
        await expect(document.locator(`[data-crop="${name}"]`)).toHaveValue(String(value));
      }
      await expect(field(document, 'confirmed')).not.toBeChecked();
      await expect(page.locator('#download-email')).toBeDisabled();
      await expect(document.locator('.download-picture')).toBeEnabled({ timeout: 60_000 });
      const picture = await download(page, document.locator('.download-picture'));
      expect(picture.subarray(0, 2).toString('hex')).toBe('ffd8');
      expect(picture.length).toBeLessThanOrEqual(350 * 1024);
      const decoded = await decodedPixels(page, picture, 'image/jpeg');
      expect(decoded.error).toBeUndefined();
      expect([decoded.width, decoded.height]).toEqual([crop.width, crop.height]);
      expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(1600);
      expect(pixelAt(decoded, 5, 5).slice(0, 3).every((value) => value > 240),
        'the cropped attachment kept the dark table border').toBe(true);
      pictures.push(picture);
      await field(document, 'confirmed').check();
    }
    await expect(page.locator('#grand-total')).toHaveText('8.27 EUR');
    await page.locator('#email-to').fill('qa@example.invalid');
    const report = await page.locator('#report-text').inputValue();
    const email = readEmail(await download(page, page.locator('#download-email')));
    expect(email.headers).toMatch(/^X-Unsent: 1$/mi);
    expect(email.headers).toMatch(/^To: qa@example\.invalid$/mi);
    expect(email.subject).toMatch(/2 documents — EUR 8\.27$/);
    expect(email.parts).toHaveLength(3);
    expect(email.parts[0].type).toBe('text/plain');
    expect(email.parts[0].bytes.toString('utf8').replace(/\r\n/g, '\n')).toBe(report.replace(/\r\n/g, '\n'));
    expect(report).toContain('QA Cafe');
    expect(report).toContain('QA Supplies');
    expect(report).toContain('QA-001');
    expect(report).toContain('QA-002');
    expect(report).toContain('Grand total: 8.27 EUR across 2 checked documents');
    for (const [index, part] of email.parts.slice(1).entries()) {
      expect(part.type).toBe('image/jpeg');
      expect(part.filename).toMatch(/\.jpg$/i);
      expect(part.bytes).toEqual(pictures[index]);
    }

    const entries = zipEntries(await download(page, page.locator('#download-images')));
    expect(entries).toHaveLength(3);
    const images = entries.filter((entry) => /\.jpg$/i.test(entry.name));
    expect(images).toHaveLength(2);
    for (const [index, image] of images.entries()) expect(image.data).toEqual(pictures[index]);
    const csv = entries.find((entry) => /\.csv$/i.test(entry.name));
    expect(csv, 'the manual attachment bundle omitted the CSV').toBeTruthy();
    const [header, ...rows] = readCsv(csv!.data.toString('utf8'));
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toHaveLength(header.length);
    const cell = (row: string[], label: string): string => {
      const index = header.indexOf(label);
      expect(index, `the CSV omitted its ${label} column`).toBeGreaterThanOrEqual(0);
      return row[index];
    };
    const documentRows = rows.filter((row) => cell(row, 'Receipt / invoice number'));
    expect(documentRows.map((row) => [
      cell(row, 'Merchant / supplier'), cell(row, 'Receipt / invoice number'),
      cell(row, 'Currency'), cell(row, 'Total'), cell(row, 'Exchange rate'),
      cell(row, 'Rate source'), cell(row, 'Final email currency'),
      cell(row, 'Converted value'), cell(row, 'Checked'),
    ])).toEqual([
      ['QA Cafe', 'QA-001', 'CAD', '12.31', '0.5', 'Manual', 'EUR', '6.16', 'Yes'],
      ['QA Supplies', 'QA-002', 'USD', '4.21', '0.5', 'Manual', 'EUR', '2.11', 'Yes'],
    ]);
    const summary = (label: string): string[] => {
      const row = rows.find((candidate) => cell(candidate, 'Document') === label);
      expect(row, `the CSV omitted its ${label} summary`).toBeTruthy();
      return row!;
    };
    expect(cell(summary('Document count'), 'Total')).toBe('2');
    expect(cell(summary('Checked document count'), 'Total')).toBe('2');
    expect(cell(summary('Grand total'), 'Final email currency')).toBe('EUR');
    expect(cell(summary('Grand total'), 'Converted value')).toBe('8.27');
  });
});
