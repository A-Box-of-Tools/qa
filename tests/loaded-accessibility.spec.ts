import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { encodePng } from '../lib/image-fixtures';
import { animationFixture } from '../lib/gif';
import { buildPdf } from '../lib/pdf';
import { loudThenQuiet } from '../lib/wav';
import { canDecodeAudio, withoutThirdParties } from '../lib/engine';

async function clean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).include('#main').analyze();
  const violations = results.violations.filter((issue) => ['serious', 'critical'].includes(issue.impact ?? ''));
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

// Each case opens a different generated interface. These complement the
// resize-image and DICOM journeys without repeating their expensive setup.
for (const slug of ['base64', 'hash-checksum', 'merge-pdf', 'gif-analyzer', 'image-to-data-uri', 'trim-audio']) {
  test(`loaded accessibility: ${slug} controls and results`, async ({ page }) => {
    test.setTimeout(150_000);
    await withoutThirdParties(page);
    await page.goto(`/${slug}/`);
    if (slug === 'base64') {
      await page.locator('#input').fill('Accessible café');
      await expect(page.locator('#output')).not.toBeEmpty();
    } else {
      if (slug === 'trim-audio') test.skip(!await canDecodeAudio(page), 'the engine cannot decode the audio fixture');
      const input = slug === 'hash-checksum'
        ? { name: 'qa.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('abc') }
        : slug === 'merge-pdf'
          ? { name: 'qa.pdf', mimeType: 'application/pdf', buffer: buildPdf([{ label: 'QA', width: 595, height: 842 }]) }
          : slug === 'gif-analyzer'
            ? { name: 'qa.gif', mimeType: 'image/gif', buffer: animationFixture(48, 32, 3).bytes }
            : slug === 'trim-audio'
              ? { name: 'qa.wav', mimeType: 'audio/wav', buffer: loudThenQuiet(2) }
              : { name: 'qa.png', mimeType: 'image/png', buffer: encodePng(96, 64, () => [80, 120, 190]) };
      await page.locator('#file-input').setInputFiles(input);
      const ready: Record<string, string> = {
        'hash-checksum': '#results', 'merge-pdf': '#page-list li',
        'gif-analyzer': '#summary-card', 'image-to-data-uri': '#results', 'trim-audio': '#source',
      };
      await expect(page.locator(ready[slug])).toBeVisible({ timeout: 30_000 });
      if (slug === 'hash-checksum') await expect(page.locator('#progress')).toBeHidden();
      if (slug === 'trim-audio') {
        await page.locator('#add-segment').click();
        await expect(page.locator('#segment-rows input')).toHaveCount(2);
      }
    }
    await clean(page);
    if (slug === 'merge-pdf') {
      await page.locator('#run').click();
      await expect(page.locator('#result')).toBeVisible();
      await clean(page);
    }
  });
}

for (const slug of ['base64', 'merge-pdf', 'gif-analyzer']) {
  test(`error accessibility: ${slug} announces a usable error`, async ({ page }) => {
    await withoutThirdParties(page);
    await page.goto(`/${slug}/`);
    if (slug === 'base64') {
      await page.locator('input[name="direction"][value="decode"]').check();
      await page.locator('#input').fill('@@@');
    } else {
      await page.locator('#file-input').setInputFiles({ name: slug === 'merge-pdf' ? 'qa.pdf' : 'qa.gif',
        mimeType: slug === 'merge-pdf' ? 'application/pdf' : 'image/gif', buffer: Buffer.from('not a file') });
    }
    const error = page.locator('#error:visible, #load-error:visible').first();
    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).not.toBeEmpty();
    await expect(error).toHaveAttribute('role', 'alert');
    await clean(page);
  });
}
