import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';

/**
 * Driving the three-card frame the newer tools share.
 *
 * Since the PDF protector, every tool built on the site has had the same
 * shape: a card with the file picker and its "Load an example" button, a card
 * of settings, and a last card that sleeps (`inert`) until there is something
 * to do, with a run button, a result block, a check line the tool writes
 * after re-opening its own output, and a download link shown only when that
 * check passed. Six specs were about to carry the same forty lines of
 * clicking and waiting, so it lives here once.
 *
 * What this does NOT do is believe the check line. It requires the tool to
 * have trusted its own output - a run the tool itself did not trust is a
 * failure with the tool's own words in it - and then hands the bytes back for
 * the spec to open with a reader of this suite's own.
 */

/** Press the example button and wait for the tool to have read the file. */
export async function loadTheExample(page: Page): Promise<void> {
  await page.locator('#example-button').click();
  await expect(page.locator('#file-row')).toBeVisible({ timeout: 90_000 });
  await expect(
    page.locator('#load-error'),
    'the tool refused its own example file',
  ).toBeHidden();
}

/** Hand the tool a file through its picker and wait for it to have been read. */
export async function loadFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('#file-row')).toBeVisible({ timeout: 90_000 });
  await expect(
    page.locator('#load-error'),
    `the tool refused ${file.name}`,
  ).toBeHidden();
}

/** The last card, asleep or awake. */
export function runCard(page: Page) {
  return page.locator('#run-card');
}

/**
 * Run the tool and save what the browser writes.
 *
 * Waits for the last card to wake, which is the tool's own statement that
 * the settings are complete; then for the result; then for the check line
 * to say the tool trusted its output, quoting it when it did not.
 */
export async function runAndSave(page: Page, { timeout = 180_000 } = {}): Promise<Buffer> {
  await expect(
    runCard(page),
    'the last card is still waiting for something',
  ).not.toHaveAttribute('inert', '', { timeout: 60_000 });
  await page.locator('#run').click();
  await expect(page.locator('#result')).toBeVisible({ timeout });
  await expect(
    page.locator('#run-error'),
    'the tool failed on the file it was given',
  ).toBeHidden();
  const said = (await page.locator('#check-line').textContent()) ?? '';
  await expect(
    page.locator('#check-line'),
    `the tool did not trust its own output: ${said}`,
  ).toHaveClass(/\bgood\b/);

  const pending = page.waitForEvent('download');
  await page.locator('#download').click();
  const saved = await pending;
  const where = await saved.path();
  if (!where) throw new Error('the browser saved no file');
  return fs.readFileSync(where);
}

/** Press one of a tool's chips - `[data-turn="180"]`, `[data-mb="8"]` and so on. */
export async function pressChip(page: Page, selector: string): Promise<void> {
  const chip = page.locator(`.chip${selector}`);
  await chip.click();
  await expect(chip, `the chip ${selector} did not take`).toHaveAttribute('aria-pressed', 'true');
}
