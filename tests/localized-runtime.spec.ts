import { test, expect, type Page } from '@playwright/test';
import { localeBody, localeUrl } from '../lib/locales';
import { expectLocalizedCopy, phraseText } from '../lib/runtime-copy';
import { encodePng } from '../lib/image-fixtures';
import { animationFixture } from '../lib/gif';
import { writeDicom } from '../lib/dicom';
import { buildPdf } from '../lib/pdf';
import { loudThenQuiet } from '../lib/wav';
import { realJpeg } from '../lib/browser-jpeg';
import { withExifGps } from '../lib/jpeg-fixtures';
import { recordVideo, canDecodeVideo } from '../lib/browser-video';
import { canDecodeAudio, withoutThirdParties } from '../lib/engine';
import { discoverTools } from '../lib/tools';

const SLUGS = ['base64', 'dicom-viewer', 'edit-audio', 'exif-editor', 'gif-analyzer',
  'gif-maker', 'grab-frame', 'hash-checksum', 'image-to-data-uri', 'image-to-ico',
  'merge-pdf', 'redact-image', 'split-gif', 'stack-images', 'trim-audio', 'trim-video',
  'crop-video', 'images-to-video'];
const png = (colour = 80) => encodePng(96, 64, () => [colour, 120, 190]);
const uploadedNames = new WeakMap<Page, Set<string>>();

function rememberFiles(page: Page, names: string[]): void {
  const remembered = uploadedNames.get(page) ?? new Set<string>();
  for (const name of names) remembered.add(name);
  uploadedNames.set(page, remembered);
}

const checkCopy = (page: Page, slug: string, locale: string) => expectLocalizedCopy(
  page, slug, locale, {
    filenames: [...(uploadedNames.get(page) ?? [])],
    // Random passwords can resemble phrase keys without being interface copy.
    generatedTextSelectors: slug === 'password-generator' ? ['output#secret'] : [],
  },
);

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  rememberFiles(page, [name]);
  await page.locator('#file-input').setInputFiles({ name, mimeType, buffer });
}

async function exercise(page: Page, slug: string, locale: string): Promise<void> {
  if (slug === 'base64') {
    await page.locator('#input').fill('café');
    await expect(page.locator('#output')).toHaveText(Buffer.from('café').toString('base64'));
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => {} },
    }));
    await page.locator('#copy').click();
    await expect(page.locator('#copy')).toHaveText(await phraseText(page, 'copy.copied'));
    return;
  }
  if (slug === 'dicom-viewer') {
    await upload(page, 'qa.dcm', 'application/dicom', writeDicom());
    await expect(page.locator('#identity-card')).toBeVisible();
    // The fixture's StudyDate is 20240102. These words are independent of
    // the page's own phrase lookup, which is what went untranslated before.
    await expect(page.locator('#main')).toContainText(locale === 'es' ? /2.*enero.*2024/ : /2.*janeiro.*2024/);
    return;
  }
  if (slug === 'hash-checksum') {
    await upload(page, 'qa.bin', 'application/octet-stream', Buffer.from('abc'));
    await expect(page.locator('#progress')).toBeHidden();
    await expect(page.locator('li.digest[data-algorithm="sha256"] [data-slot="value"]'))
      .toHaveText('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('Clipboard refused by the test'); } },
    }));
    await page.locator('#copy-all').click();
    const download = ((await page.locator('#download-checksums').textContent()) ?? '').trim();
    await expect(page.locator('#copy-status')).toHaveText((await phraseText(page, 'copy.failed')).replace('{download}', download));
    return;
  }
  if (slug === 'exif-editor') {
    await upload(page, 'qa.jpg', 'image/jpeg', withExifGps(await realJpeg(page, 96, 64)));
    await expect(page.locator('#inspector')).toBeVisible();
    await expect(page.locator('#tag-groups')).not.toBeEmpty();
    return;
  }
  if (slug === 'gif-analyzer' || slug === 'split-gif') {
    await upload(page, 'qa.gif', 'image/gif', animationFixture(48, 32, 3).bytes);
    await expect(page.locator(slug === 'gif-analyzer' ? '#summary-card' : '#frames-card')).toBeVisible();
    await expect(page.locator(slug === 'gif-analyzer' ? '#findings-card' : '#frames')).not.toBeEmpty();
    return;
  }
  if (slug === 'merge-pdf') {
    await upload(page, 'qa.pdf', 'application/pdf', buildPdf([{ label: 'QA', width: 595, height: 842 }]));
    await expect(page.locator('#page-list li')).toHaveCount(1);
    await expect(page.locator('#page-list')).toContainText(locale === 'es' ? /A4.*vertical/ : /A4.*retrato/);
    await page.locator('#run').click();
    await expect(page.locator('#result')).toBeVisible();
    return;
  }
  if (slug === 'edit-audio' || slug === 'trim-audio') {
    test.skip(!await canDecodeAudio(page), 'the engine cannot decode the audio fixture');
    await upload(page, 'qa.wav', 'audio/wav', loudThenQuiet(2));
    await expect(page.locator('#source')).toBeVisible();
    if (slug === 'trim-audio') await segments(page);
    else {
      await page.locator('#export').click();
      await expect(page.locator('#result')).toBeVisible();
    }
    return;
  }
  if (['grab-frame', 'trim-video', 'crop-video'].includes(slug)) {
    const clip = await recordVideo(page, { width: 160, height: 120, seconds: 1, fps: 10 });
    test.skip(!await canDecodeVideo(page, clip.bytes, clip.mimeType), 'the engine cannot decode the video fixture; malformed-file messages have a separate case');
    if (slug === 'trim-video') {
      // A single clip intentionally has no list or ordering controls.
      const names = ['qa-first.mp4', 'qa-second.mp4'];
      rememberFiles(page, names);
      await page.locator('#file-input').setInputFiles(names.map((name) => ({
        name, mimeType: clip.mimeType, buffer: clip.bytes,
      })));
      await expect(page.locator('#clip-list li')).toHaveCount(2);
      await segments(page);
      const buttons = page.locator('#clip-list button');
      for (const key of ['seg.up', 'seg.down', 'seg.remove']) {
        const text = await phraseText(page, key);
        expect(await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')))).toContain(text);
      }
    } else {
      await upload(page, 'qa.mp4', clip.mimeType, clip.bytes);
      await expect(page.locator('#source')).toBeVisible();
      if (slug === 'grab-frame') {
        await page.locator('#grab').click();
        await expect(page.locator('#shots li')).toHaveCount(1, { timeout: 30_000 });
      }
    }
    return;
  }
  if (['gif-maker', 'stack-images', 'images-to-video'].includes(slug)) {
    rememberFiles(page, ['qa-0.png', 'qa-1.png']);
    await page.locator('#file-input').setInputFiles([80, 180].map((colour, index) => ({
      name: `qa-${index}.png`, mimeType: 'image/png', buffer: png(colour),
    })));
    if (slug === 'stack-images' && !await page.evaluate(() => typeof OffscreenCanvas === 'function')) {
      await expect(page.locator('#error')).toContainText('OffscreenCanvas');
      return;
    }
    await expect(page.locator(slug === 'images-to-video' ? '#image-list li' : '#frame-list li')).toHaveCount(2);
    if (slug === 'gif-maker') {
      await page.locator('#export').click();
      await expect(page.locator('#result')).toBeVisible();
    } else if (slug === 'stack-images') {
      const capable = await page.evaluate(() => typeof OffscreenCanvas !== 'undefined');
      if (capable) {
        await page.locator('#run').click();
        await expect(page.locator('#result')).toBeVisible();
      } else await expect(page.locator('#error')).toContainText('OffscreenCanvas');
    }
    return;
  }
  await upload(page, 'qa.png', 'image/png', png());
  const ready: Record<string, string> = {
    'image-to-data-uri': '#results', 'image-to-ico': '#preview', 'redact-image': '#edit-controls',
  };
  await expect(page.locator(ready[slug])).toBeVisible();
  if (slug === 'image-to-ico') {
    await page.locator('#make-icon').click();
    await expect(page.locator('#results')).toBeVisible();
  }
}

async function segments(page: Page): Promise<void> {
  await page.locator('#add-segment').click();
  const inputs = page.locator('#segment-rows input');
  await expect(inputs).toHaveCount(2);
  await expect(inputs.nth(0)).toHaveAttribute('aria-label', await phraseText(page, 'time.start'));
  await expect(inputs.nth(1)).toHaveAttribute('aria-label', await phraseText(page, 'time.end'));
  await expect(inputs.nth(1)).toHaveAttribute('placeholder', await phraseText(page, 'time.open'));
}

for (const locale of ['es', 'pt']) {
  test.describe(`${locale}: translated runtime controls and results`, () => {
    for (const slug of discoverTools()) {
      test(`${slug} keeps interface text and accessible labels translated${SLUGS.includes(slug) ? ' after use' : ' at rest'}`, async ({ page }) => {
        // A new tool can ship in English before its page is translated. The
        // locale parity and page checks still guard how that fallback is offered.
        test.skip(localeBody(locale, slug) === null,
          'not translated; fallback pages are covered by the locale parity and page tests');
        test.setTimeout(180_000);
        await withoutThirdParties(page);
        await page.goto(localeUrl(locale, slug));
        await checkCopy(page, slug, locale);
        if (SLUGS.includes(slug)) {
          await exercise(page, slug, locale);
          await checkCopy(page, slug, locale);
        }
      });
    }
    for (const slug of ['crop-video', 'grab-frame', 'trim-video', 'merge-pdf', 'gif-analyzer', 'image-to-ico']) {
      test(`${slug} translates malformed-file errors too`, async ({ page }) => {
        await withoutThirdParties(page);
        await page.goto(localeUrl(locale, slug));
        const type = slug.includes('video') || slug === 'grab-frame' ? ['qa.mp4', 'video/mp4']
          : slug === 'merge-pdf' ? ['qa.pdf', 'application/pdf']
            : slug === 'gif-analyzer' ? ['qa.gif', 'image/gif'] : ['qa.png', 'image/png'];
        await upload(page, type[0], type[1], Buffer.from('not a supported file'));
        await expect(page.locator('#load-error:visible, #error:visible').first()).toBeVisible({ timeout: 30_000 });
        await checkCopy(page, slug, locale);
      });
    }
    test('images-to-video substitutes the invalid web address in its translated refusal', async ({ page }) => {
      await withoutThirdParties(page);
      await page.goto(localeUrl(locale, 'images-to-video'));
      await page.locator('#url-panel summary').click();
      await page.locator('#url-input').fill('not a url');
      await page.locator('#fetch-urls').click();
      await expect(page.locator('#error')).toBeVisible();
      await expect(page.locator('#error')).toContainText((await phraseText(page, 'url.invalid')).replace('{address}', 'not a url'));
      await expect(page.locator('#fetch-urls')).toBeEnabled();
      await checkCopy(page, 'images-to-video', locale);
    });
  });
}
