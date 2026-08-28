import { test, expect } from '@playwright/test';
import { discoverTools, hasFilePicker } from '../lib/tools';
import { encodePng } from '../lib/image-fixtures';

/**
 * A card that is on the page but not yet usable says what would make it so.
 *
 * The last step of a tool is rendered dimmed and inert, so the whole job can
 * be read before a file is committed to it. Eleven tools were left showing a
 * heading and a disabled button and nothing else - "3 Compress", "4 Your
 * stills", "2 What it says" - which tells a reader the step exists and not
 * what opens it.
 *
 * The sentence comes from the frame and is put in by the shared picker, so
 * this is a rule about every such card rather than about eleven of them.
 */
test.describe('a dimmed card says what it waits for', () => {
  for (const slug of discoverTools().filter((tool) => hasFilePicker(tool))) {
    test(`${slug}`, async ({ page }) => {
      await page.goto(`/${slug}/`);

      const dimmed = page.locator('#main .card[inert]');
      const count = await dimmed.count();
      test.skip(count === 0, 'this tool holds nothing back until a file arrives');

      // Every one of them, not just the first: a tool with two waiting cards
      // should not explain one and leave the other bare.
      for (let i = 0; i < count; i += 1) {
        await expect(
          dimmed.nth(i).locator('.card-waiting'),
          `a dimmed card on /${slug}/ says nothing about what would open it`,
        ).toHaveCount(1);
      }
    });
  }
});

test.describe('and stops saying it once it can work', () => {
  test('the line goes when the file arrives', async ({ page }) => {
    // The other half. A line that never left would sit under live controls
    // telling the reader to choose a file they have already chosen.
    test.setTimeout(120_000);
    await page.goto('/compress-image/');
    await expect(page.locator('.card-waiting').first()).toBeVisible({ timeout: 20_000 });

    await page.locator('#file-input').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: encodePng(80, 60, () => [30, 160, 90]),
    });

    await expect(page.locator('.card-waiting')).toHaveCount(0, { timeout: 30_000 });
  });
});
