import { expect, type Page } from '@playwright/test';

/**
 * The two-pane text tools, driven the same way.
 *
 * Five of them now wear the same shape - a box you type into, a box the
 * answer appears in, a Clear, and settings that change the answer without
 * anything being pressed: json-formatter, base64, text-diff, and the two
 * website #296 added, xml-formatter and yaml-to-json.
 *
 * These three functions were written for the first of them and then copied
 * into the second, comment and all. Two more tools was the moment to stop
 * copying: what is written here is not a convenience but a pair of traps,
 * both of which have already cost a wrong result that looked right, and a
 * fifth copy is a fifth chance for one of them to be fixed in four places.
 */

/**
 * Type into the main box and read the output back.
 *
 * Clearing first is what makes the reading trustworthy. The output box is
 * already full from whatever ran before, so "wait until it is not empty" is
 * satisfied instantly by the previous answer - which is how the first draft
 * of the encoder's tests managed to compare base64url's output against
 * base64's and call it a round-trip failure. Empty, then filled, is a state
 * the previous run cannot have left behind.
 */
export async function through(page: Page, text: string): Promise<string> {
  await page.locator('#clear').click();
  await expect(page.locator('#output')).toBeEmpty({ timeout: 20_000 });
  await page.locator('#input').fill(text);
  await expect(page.locator('#output')).not.toBeEmpty({ timeout: 20_000 });
  return (await page.locator('#output').textContent()) ?? '';
}

/**
 * Change a setting and wait for the answer to actually change.
 *
 * The same trap in a different shape: after flipping a switch the old output
 * is still on screen, and reading it immediately reads the answer to the
 * previous question.
 *
 * Polled rather than `toHaveText`, because that normalises whitespace - and
 * on a formatter the whitespace is the entire subject. Changing the indent
 * from two spaces to four changes nothing a normalising comparison can see,
 * so the wait would sit there until it timed out while the page had in fact
 * answered immediately.
 */
export async function afterSetting(
  page: Page,
  change: () => Promise<unknown>,
): Promise<string> {
  const read = async () => (await page.locator('#output').textContent()) ?? '';
  const before = await read();
  await change();
  await expect.poll(read, { timeout: 20_000 }).not.toBe(before);
  return read();
}

/** Switch to a tab and wait for its panel. */
export async function mode(page: Page, name: string): Promise<void> {
  await page.locator(`#tab-${name}`).click();
  await expect(page.locator(`#options-${name}`)).toBeVisible();
}
