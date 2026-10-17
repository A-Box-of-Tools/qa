import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from '../../lib/site';
import { encodePng } from '../../lib/image-fixtures';

const available = fs.existsSync(path.join(ETOOLBOX_DIR, 'shared', 'js', 'codec-support-worker.js'));
const tools = [
  'images-to-video', 'reverse-video', 'timelapse-video', 'crop-video', 'trim-video',
  'compress-video', 'convert-to-mp4', 'extract-audio-from-video', 'gif-to-mp4',
  'grab-frame', 'rotate-video', 'video-to-gif',
];

test.beforeEach(() => {
  test.skip(!available, 'Worker-isolated H.264 capability checks are awaiting the website release.');
});

async function observeNativePage(context: BrowserContext, page: Page, slug: string) {
  // Observe worker creation without replacing the encoder, navigator identity,
  // native query or response. A missing guard still reaches the real engine.
  await context.addInitScript(() => {
    const state = { workers: [] as string[], ticks: 0, clicks: 0 };
    (window as any).__nativeGuardQA = state;
    setInterval(() => { state.ticks++; }, 25);
    const NativeWorker = window.Worker;
    Object.defineProperty(window, 'Worker', { configurable: true, value: class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        state.workers.push(String(url));
        super(url, options);
      }
    } });
  });
  await page.goto(`/${slug}/`);
  const identity = await page.evaluate(() => ({
    platform: navigator.platform, vendor: navigator.vendor, userAgent: navigator.userAgent,
  }));
  const guardedRuntime = /^Linux\b/i.test(identity.platform)
    && identity.vendor === 'Apple Computer, Inc.' && /\bAppleWebKit\//.test(identity.userAgent)
    && !/\b(?:Chromium|Chrome|CriOS|Edg|EdgA|EdgiOS|OPR|Firefox|FxiOS)\//.test(identity.userAgent);
  test.skip(!guardedRuntime, 'The native Linux WebKit compatibility guard does not apply to this actual public runtime identity.');
  expect(await page.evaluate(() => typeof (globalThis as any).VideoEncoder?.isConfigSupported),
    'This regression must exercise refusal despite an exposed native capability API').toBe('function');
  expect(await page.evaluate(() => typeof (globalThis as any).VideoFrame),
    'A missing VideoFrame must not bypass the guarded capability query').toBe('function');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'qa-native-responsive';
    button.type = 'button';
    button.textContent = 'Check page responsiveness';
    button.style.cssText = 'position:fixed;top:4px;left:4px;z-index:2147483647;width:210px;height:44px;';
    button.onclick = event => {
      if (event.isTrusted) (window as any).__nativeGuardQA.clicks++;
    };
    document.body.append(button);
  });
  await page.locator('#qa-native-responsive').click();
  expect(await page.evaluate(() => (window as any).__nativeGuardQA.clicks)).toBe(1);
  return identity;
}

async function responsiveWithoutWorker(page: Page) {
  const before = await page.evaluate(() => ({ ...(window as any).__nativeGuardQA }));
  await page.locator('#qa-native-responsive').click({ timeout: 2_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__nativeGuardQA.ticks), { timeout: 2_000 })
    .toBeGreaterThan(before.ticks);
  const after = await page.evaluate(() => (window as any).__nativeGuardQA);
  expect(after.clicks).toBe(before.clicks + 1);
  expect(after.workers, 'The affected native encoder must be refused before any worker is created').toEqual([]);
}

for (const slug of tools) {
  test(`${slug}: native Linux WebKit refuses the unsafe encoder query and remains responsive on retry`, async ({ page, context }, testInfo) => {
    const identity = await observeNativePage(context, page, slug);
    await testInfo.attach('unmodified-native-runtime', { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json' });
    const modulePath = slug === 'images-to-video' ? 'support.js' : 'shared/video-support.js';
    for (const attempt of [1, 2]) {
      const result = await page.evaluate(async ({ slug, modulePath }) => {
        const { pickH264Codec } = await import(`/${slug}/src/${modulePath}`);
        return pickH264Codec({ width: 320, height: 240, framerate: 30, bitrate: 1_200_000 });
      }, { slug, modulePath });
      expect(result, `Native guarded attempt ${attempt} must refuse without probing the encoder`).toBeNull();
      await responsiveWithoutWorker(page);
    }
  });
}

test('images-to-video: native Linux WebKit gives readable refusal, retains images and allows an explicit retry', async ({ page, context }, testInfo) => {
  const identity = await observeNativePage(context, page, 'images-to-video');
  await testInfo.attach('unmodified-native-runtime', { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json' });
  await page.locator('#file-input').setInputFiles([0, 1].map(index => ({
    name: `native-${index}.png`, mimeType: 'image/png',
    buffer: encodePng(320, 240, () => index ? [200, 50, 80] : [40, 190, 60]),
  })));
  await expect(page.locator('#image-list li')).toHaveCount(2);
  for (const attempt of [1, 2]) {
    await page.locator('#export').click();
    await expect(page.locator('#error')).toBeVisible({ timeout: 4_000 });
    await expect(page.locator('#error')).toContainText(/H\.264/i);
    await expect(page.locator('#export')).toBeEnabled();
    await expect(page.locator('#progress')).toBeHidden();
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#image-list li')).toHaveCount(2);
    await responsiveWithoutWorker(page);
    await testInfo.attach(`native-guard-refusal-${attempt}`, { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test('convert-to-mp4: native Linux WebKit refuses its VP8 example before querying and permits retry', async ({ page, context }, testInfo) => {
  const identity = await observeNativePage(context, page, 'convert-to-mp4');
  await testInfo.attach('unmodified-native-runtime', { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json' });
  expect(await page.evaluate(() => typeof (globalThis as any).AudioEncoder),
    'The example must reach its VP8 query rather than refuse earlier for a missing audio API').toBe('function');
  for (const attempt of [1, 2]) {
    const error = await page.evaluate(async () => {
      const moduleURL = '/convert-to-mp4/src/example.js';
      const { makeExample } = await import(moduleURL);
      try {
        await makeExample('native-refusal.webm', { width: 320, height: 240, fps: 1, seconds: 1 });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(error, `Native VP8 attempt ${attempt} must stop before any encoder is configured`).toBe('example.novp8');
    await responsiveWithoutWorker(page);
  }
});
