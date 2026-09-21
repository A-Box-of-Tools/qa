import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { realJpeg } from '../../lib/browser-jpeg';
import { decodedSize } from '../../lib/browser-image';
import { quiet } from '../../lib/engine';

/**
 * Tool-level functional tests for the ID Photo Maker.
 *
 * This tool's output is checked by somebody else, against a published rule,
 * after the person has paid a fee. A photo that is a few pixels wrong, or a
 * kilobyte under a floor, is refused - and the refusal arrives weeks later
 * from a passport office rather than from the tool.
 *
 * Its README is explicit that the interesting numbers are not the aspect
 * ratio: "Indian examination portals want 200 x 230 pixels and 20-50 KB. That
 * is a floor as well as a ceiling, and a floor cannot be met by compressing
 * less once the encoder has run out of less."
 *
 * So the tests here check the files against the figures in src/specs.js - a
 * rulebook that records the authority and the date each was read - rather than
 * against anything the page says about itself.
 */

const URL_PATH = '/id-photo/';

const MM_PER_INCH = 25.4;
/** The pixel size a print spec works out to, the way the tool must compute it. */
const printPixels = (mm: number, dpi: number): number => Math.round((mm / MM_PER_INCH) * dpi);

/** A portrait photograph for the tool to crop. */
async function portrait(page: Page): Promise<Buffer> {
  return realJpeg(page, 900, 1200, 3);
}

/**
 * Whether the country chooser is still a <select> with a search box over it.
 *
 * THIS IS A BRIDGE AND COMES OUT. The chooser became one control - a box that
 * is typed into and the list it narrows - and this file runs against the site
 * that is live as well as the preview that changes it, so for one release it
 * has to drive both. Once /id-photo/ is live with `#country-list` on it, delete
 * this, the two `if (await isMenu(page))` branches and this paragraph.
 */
async function isMenu(page: Page): Promise<boolean> {
  return (await page.locator('select#country').count()) > 0;
}

/** Every country the chooser holds, by the key the page knows it by. */
async function countryKeys(page: Page): Promise<string[]> {
  if (await isMenu(page)) {
    return page.locator('#country option').evaluateAll(
      (options) => options.map((option) => (option as HTMLOptionElement).value));
  }
  // The list is filled while it is closed, so it can be read without opening it.
  return page.locator('#country-list [role="option"]').evaluateAll(
    (rows) => rows.map((row) => (row as HTMLElement).dataset.value ?? ''));
}

async function chooseCountry(page: Page, key: string): Promise<void> {
  if (await isMenu(page)) {
    await page.locator('#country').selectOption(key);
    return;
  }
  // The arrow on the end of the box opens the whole list, typed text or none.
  await page.locator('#country-toggle').click();
  await page.locator(`#country-list [data-value="${key}"]`).click();
  await expect(page.locator('#country-list')).toBeHidden();
}

/**
 * Choose one of the rules, whatever country it belongs to.
 *
 * The chooser is a country and then that country's documents, so a rule is two
 * controls away rather than one, and the page only builds the radio for a
 * document once its country has been picked. Rather than keep a copy of which
 * country each rule belongs to - a second rulebook, in another repository,
 * with nothing to keep it in step - this walks the country list until the
 * radio it is after exists.
 */
async function chooseSpec(page: Page, spec: string): Promise<void> {
  const radio = page.locator(`#doc-${spec}`);
  await expect(page.locator('#country')).toBeVisible();

  if ((await radio.count()) === 0) {
    // The combined control says on each row which rules are behind it, so the
    // country is one lookup. The menu it replaced does not, and is walked: a
    // <select> can be set forty times in a second, which opening a list and
    // pressing a row cannot - on a phone that walk ran past the test's time.
    const home = await page.locator('#country-list [role="option"]').evaluateAll(
      (rows, wanted) => (rows as HTMLElement[])
        .find((row) => (row.dataset.rules ?? '').split(' ').includes(wanted))?.dataset.value ?? '',
      spec);
    const candidates = home ? [home] : await countryKeys(page);
    for (const country of candidates) {
      await chooseCountry(page, country);
      if ((await radio.count()) > 0) break;
    }
  }

  await expect(radio).toHaveCount(1);
  await radio.check();
}

/** Load a photo and choose a specification. */
async function setup(page: Page, spec: string): Promise<void> {
  await page.goto(URL_PATH);
  await page.locator('#file-input').setInputFiles({
    name: 'portrait.jpg',
    mimeType: 'image/jpeg',
    buffer: await portrait(page),
  });
  await expect(page.locator('#frame-controls')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#load-error')).toBeHidden();

  await chooseSpec(page, spec);
  // The dots open at default positions the moment a photo loads, so the crop
  // box can be fitted without anyone dragging anything.
  await page.locator('#fit-box').click();
}

interface Made {
  title: string;
  detail: string;
  bytes: Buffer;
}

/** Make the files and return every one the page offers, with its own caption. */
async function makeFiles(page: Page): Promise<Made[]> {
  await expect(page.locator('#make')).toBeEnabled({ timeout: 20_000 });
  await page.locator('#make').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 60_000 });

  const rows = page.locator('#result-list li');
  const count = await rows.count();
  const out: Made[] = [];

  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const link = row.locator('a[download]').first();
    if (await link.count() === 0) continue;

    const pending = page.waitForEvent('download');
    await link.click();
    const saved = await pending;
    const path = await saved.path();
    if (!path) throw new Error('the browser saved no file');

    out.push({
      title: ((await row.locator('.result-title').textContent()) ?? '').trim(),
      detail: ((await row.locator('.result-detail').textContent()) ?? '').trim(),
      bytes: fs.readFileSync(path),
    });
  }

  return out;
}

test.describe('id-photo: the file a web form will accept', () => {
  test('the Indian exam photo is exactly 200 x 230 and inside 20-50 KB', async ({ page }) => {
    // The case the README singles out, and the one with a floor. Compressing
    // harder cannot fix a file that is too small, so a tool that only ever
    // squeezes downwards will fail this and pass every ceiling-only rule.
    test.setTimeout(120_000);
    await setup(page, 'in-exam-photo');

    const made = await makeFiles(page);
    expect(made.length, 'no files were produced').toBeGreaterThan(0);

    const upload = made.find((item) => /upload|online|photo/i.test(item.title)) ?? made[0];
    const size = await decodedSize(page, upload.bytes, 'image/jpeg');

    expect(size.width, 'the upload is not 200 px wide').toBe(200);
    expect(size.height, 'the upload is not 230 px tall').toBe(230);

    const kb = upload.bytes.length / 1024;
    expect(kb, `the upload is ${kb.toFixed(1)} KB, under the 20 KB floor`)
      .toBeGreaterThanOrEqual(20);
    expect(kb, `the upload is ${kb.toFixed(1)} KB, over the 50 KB ceiling`)
      .toBeLessThanOrEqual(50);

    // A JPEG, as the form requires.
    expect(upload.bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

test.describe('id-photo: the print sizes are the published ones', () => {
  test('the ICAO print is 35 x 45 mm at 300 DPI', async ({ page }) => {
    // 413 x 531 pixels. Not a round number, which is exactly why it is worth
    // asserting: it can only be right by being computed from the rule.
    test.setTimeout(120_000);
    await setup(page, 'icao');

    const made = await makeFiles(page);
    const print = made.find((item) => /print/i.test(item.title)) ?? made[0];
    const size = await decodedSize(page, print.bytes, 'image/jpeg');

    expect(size.width).toBe(printPixels(35, 300));
    expect(size.height).toBe(printPixels(45, 300));
    expect(size.width).toBe(413);
    expect(size.height).toBe(531);
  });

  test('the US passport print is square, at its own size', async ({ page }) => {
    // 51 x 51 mm, not 35 x 45 - so a tool with one hard-coded shape fails here
    // while passing the test above.
    test.setTimeout(120_000);
    await setup(page, 'us-passport');

    const made = await makeFiles(page);
    const print = made.find((item) => /print/i.test(item.title)) ?? made[0];
    const size = await decodedSize(page, print.bytes, 'image/jpeg');

    expect(size.width).toBe(printPixels(51, 300));
    expect(size.height).toBe(size.width);
  });

  test('choosing a different country changes the stated rule', async ({ page }) => {
    // The facts panel is the tool's own account of what it is about to do, and
    // it has to move when the rule does - the UK's head band is not ICAO's.
    await page.goto(URL_PATH);

    await chooseSpec(page, 'icao');
    const icao = ((await page.locator('#spec-facts').textContent()) ?? '').trim();

    await chooseSpec(page, 'uk-passport');
    const uk = ((await page.locator('#spec-facts').textContent()) ?? '').trim();

    expect(icao.length).toBeGreaterThan(0);
    expect(uk).not.toBe(icao);

    // And each cites where its figures came from.
    await expect(page.locator('#spec-source')).not.toBeEmpty();
  });

  test('typing to find a country narrows the list and never moves the rule', async ({ page }) => {
    // The list is forty-odd countries long now, so it can be typed into. Its
    // own notes name the way that could go wrong: "the rule the crop box is
    // obeying must not change because a word was half typed". Nothing on the
    // page would look broken - the photo would just be cut to another
    // country's rule.
    await page.goto(URL_PATH);
    await chooseSpec(page, 'uk-passport');
    const facts = ((await page.locator('#spec-facts').textContent()) ?? '').trim();
    const everything = (await countryKeys(page)).length;
    expect(everything, 'the country list is shorter than the rulebook').toBeGreaterThan(30);

    if (await isMenu(page)) {
      const country = page.locator('#country');
      const chosen = await country.inputValue();
      const other = await country.locator('option').evaluateAll((options, mine) => {
        const found = (options as HTMLOptionElement[]).find((option) => option.value !== mine);
        return { value: found?.value ?? '', label: (found?.textContent ?? '').trim() };
      }, chosen);
      expect(other.label.length).toBeGreaterThan(0);

      await page.locator('#country-filter').fill(other.label);
      await expect(page.locator('#filter-note')).not.toBeEmpty();
      const shown = await countryKeys(page);
      expect(shown.length, 'typing did not narrow the list').toBeLessThan(everything);
      expect(shown, 'the country that was typed is not on the list').toContain(other.value);
      expect(shown, 'the chosen country was filtered off its own list').toContain(chosen);
      expect(await country.inputValue()).toBe(chosen);
      await expect(page.locator('#doc-uk-passport')).toBeChecked();
      expect(((await page.locator('#spec-facts').textContent()) ?? '').trim()).toBe(facts);

      await page.locator('#country-filter').fill('');
      await expect(country.locator('option')).toHaveCount(everything);
      expect(await country.inputValue()).toBe(chosen);
      return;
    }

    const box = page.locator('#country');
    const rows = page.locator('#country-list [role="option"]');
    const chosenName = await box.inputValue();
    const chosenKey = await page.locator('#country-list [aria-selected="true"]')
      .evaluate((row) => (row as HTMLElement).dataset.value ?? '');

    // Some other country, by the name this page gives it, so the test types
    // what a visitor to this page would and not an English word.
    const other = await rows.evaluateAll((all, mine) => {
      const found = (all as HTMLElement[]).find((row) => row.dataset.value !== mine);
      return { value: found?.dataset.value ?? '', label: (found?.textContent ?? '').trim() };
    }, chosenKey);
    expect(other.label.length).toBeGreaterThan(0);

    await box.fill(other.label);
    await expect(page.locator('#country-list')).toBeVisible();
    await expect(page.locator('#filter-note')).not.toBeEmpty();
    const shown = await countryKeys(page);
    expect(shown.length, 'typing did not narrow the list').toBeLessThan(everything);
    expect(shown[0], 'the country that was typed is not the first answer').toBe(other.value);

    // Typing asked a question and chose nothing: the rule in force is still
    // the one that was picked, and the page still shows it.
    await expect(page.locator('#doc-uk-passport')).toBeChecked();
    expect(((await page.locator('#spec-facts').textContent()) ?? '').trim()).toBe(facts);

    // Walking away puts the chosen name back, and the list is whole again.
    await box.press('Escape');
    await expect(page.locator('#country-list')).toBeHidden();
    expect(await box.inputValue()).toBe(chosenName);
    await expect(rows).toHaveCount(everything);
    await expect(page.locator('#doc-uk-passport')).toBeChecked();

    // And Enter on the first answer is a choice: the other country's rule.
    await box.fill(other.label);
    await box.press('Enter');
    await expect(page.locator('#doc-uk-passport')).toHaveCount(0);
    expect(((await page.locator('#spec-facts').textContent()) ?? '').trim()).not.toBe(facts);
  });
});

test.describe('id-photo: the promise', () => {
  test('the photograph never leaves the page', async ({ page }) => {
    // The README makes the point that this matters more here than elsewhere:
    // the file is a photograph of somebody's face, and what they are about to
    // do with it names the country whose document they are applying for.
    test.setTimeout(120_000);

    const traffic: string[] = [];
    await page.goto(URL_PATH);
    page.on('request', (req) => {
      traffic.push(`${req.method()} ${req.url()} ${(req.postData() ?? '').slice(0, 8000)}`);
    });

    const face = await portrait(page);
    await page.locator('#file-input').setInputFiles({
      name: 'face.jpg',
      mimeType: 'image/jpeg',
      buffer: face,
    });
    await expect(page.locator('#frame-controls')).toBeVisible({ timeout: 20_000 });
    await chooseSpec(page, 'icao');
    await page.locator('#fit-box').click();
    await makeFiles(page);
    await quiet(page);

    // Looked for by a distinctive slice of the file's own bytes rather than by
    // words like "jpeg" or "base64": the analytics tag legitimately reports the
    // address and title of the page being viewed, and a pattern that broad
    // flags the tool's own name while saying nothing about the file.
    const marker = face.toString('base64').slice(400, 480);
    expect(marker.length).toBeGreaterThan(0);
    for (const entry of traffic) {
      expect(entry, 'the photograph was sent').not.toContain(marker);
    }
  });
});
