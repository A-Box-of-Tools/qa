import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from '../../lib/site';
import { encodePng } from '../../lib/image-fixtures';
import { codecWorkerFixture, codecState, prepareCodecResponsiveness, responsiveDuringCodecQuery } from '../../lib/codec-worker';

const workerFilename = 'codec-support-worker.js';
const available = fs.existsSync(path.join(ETOOLBOX_DIR, 'shared', 'js', workerFilename));
const tools = [
  'images-to-video', 'reverse-video', 'timelapse-video', 'crop-video', 'trim-video',
  'compress-video', 'convert-to-mp4', 'extract-audio-from-video', 'gif-to-mp4',
  'grab-frame', 'rotate-video', 'video-to-gif',
];

// A service-worker cache must not bypass the controlled platform query. The
// dedicated worker and the deployed page's CSP remain fully active.
test.use({ serviceWorkers: 'block' });

test.beforeEach(() => {
  test.skip(!available, 'Worker-isolated H.264 capability checks are awaiting the website release.');
});

async function startProbe(page: Page, slug: string) {
  const modulePath = slug === 'images-to-video' ? 'support.js' : 'shared/video-support.js';
  await page.evaluate(async ({ slug, modulePath }) => {
    const support = await import(`/${slug}/src/${modulePath}`);
    const state = { done: false, result: undefined, error: null, elapsed: 0 } as any;
    (window as any).__codecProbe = state;
    const start = performance.now();
    void support.pickH264Codec({ width: 320, height: 240, framerate: 30, bitrate: 1_200_000 })
      .then((result: string | null) => { state.result = result; }, (error: Error) => { state.error = error.message; })
      .finally(() => { state.elapsed = performance.now() - start; state.done = true; });
  }, { slug, modulePath });
}

async function completedProbe(page: Page, result: string | null) {
  await expect.poll(() => page.evaluate(() => (window as any).__codecProbe.done), { timeout: 8_000 }).toBe(true);
  const probe = await page.evaluate(() => (window as any).__codecProbe);
  expect(probe.error).toBeNull();
  expect(probe.result).toBe(result);
  expect(probe.elapsed, 'The parent deadline must beat the worker fixture’s 15-second blocking loop').toBeLessThan(8_000);
}

async function onlyWorkerQueries(page: Page, slug: string, queries: string[]) {
  const state = await codecState(page);
  expect(state.mainQueries, 'A capability fallback must never query the main-thread VideoEncoder').toBe(0);
  expect(state.encoderConstructions).toBe(0);
  expect(state.workers).toHaveLength(1);
  const worker = state.workers[0];
  const url = new URL(worker.url);
  expect(url.origin).toBe(new URL(page.url()).origin);
  expect(url.pathname).toBe(`/${slug}/src/shared/${workerFilename}`);
  const main = await page.evaluate((slug) => [...document.scripts]
    .find((script) => script.src && new URL(script.src).pathname === `/${slug}/src/main.js`)?.src, slug);
  expect(main, 'The page must load its versioned main module').toBeTruthy();
  const version = new URL(main!).searchParams.get('v');
  expect(version).toBeTruthy();
  expect(url.searchParams.get('v'), 'Worker and page must belong to the same deployed bundle').toBe(version);
  expect(worker.queries).toEqual(queries);
  expect(worker.terminated, 'Success and refusal both release the native worker').toBe(true);
}

for (const slug of tools) {
  test(`${slug}: a synchronously blocked codec worker cannot freeze the page or multiply the deadline`, async ({ page, context }) => {
    await codecWorkerFixture(context, workerFilename, 'blocking');
    await page.goto(`/${slug}/`);
    const clickTarget = await prepareCodecResponsiveness(page);
    await startProbe(page, slug);
    // A missing asset or CSP refusal also returns null. Neither can satisfy
    // this marker proving the real worker entered the synchronous query.
    await expect.poll(async () => (await codecState(page)).workers[0]?.queries, { timeout: 5_000 })
      .toEqual(['avc1.640034']);
    await responsiveDuringCodecQuery(page, clickTarget);
    await completedProbe(page, null);
    await onlyWorkerQueries(page, slug, ['avc1.640034']);
  });

  test(`${slug}: the same-origin codec worker preserves candidate order and returns a supported codec`, async ({ page, context }) => {
    await codecWorkerFixture(context, workerFilename, 'supported');
    await page.goto(`/${slug}/`);
    await startProbe(page, slug);
    await completedProbe(page, 'avc1.640033');
    await onlyWorkerQueries(page, slug, ['avc1.640034', 'avc1.640033']);
  });
}

async function loadImages(page: Page) {
  await page.goto('/images-to-video/');
  await page.locator('#file-input').setInputFiles([0, 1].map((index) => ({
    name: `codec-${index}.png`, mimeType: 'image/png',
    buffer: encodePng(320, 240, () => index ? [220, 40, 40] : [40, 200, 60]),
  })));
  await expect(page.locator('#image-list li')).toHaveCount(2);
  await expect(page.locator('#export')).toBeEnabled();
}

async function refusedExport(page: Page) {
  await expect(page.locator('#error')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('#error')).toContainText(/H\.264/i);
  await expect(page.locator('#export')).toBeEnabled();
  await expect(page.locator('#progress')).toBeHidden();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#image-list li')).toHaveCount(2);
  const state = await codecState(page);
  expect(state.mainQueries).toBe(0);
  expect(state.encoderConstructions).toBe(0);
  expect(state.workers.every((worker) => worker.terminated)).toBe(true);
}

test('images-to-video: a blocked worker yields a readable refusal and a fresh explicit retry', async ({ page, context }, testInfo) => {
  await codecWorkerFixture(context, workerFilename, 'blocking');
  await loadImages(page);
  for (const attempt of [1, 2]) {
    await page.locator('#export').scrollIntoViewIfNeeded();
    const clickTarget = await prepareCodecResponsiveness(page);
    await page.locator('#export').click({ timeout: 5_000 });
    await expect.poll(async () => (await codecState(page)).workers.length).toBe(attempt);
    await expect.poll(async () => (await codecState(page)).workers[attempt - 1]?.queries)
      .toEqual(['avc1.640034']);
    await responsiveDuringCodecQuery(page, clickTarget);
    await refusedExport(page);
    await testInfo.attach(attempt === 1 ? 'codec-refusal' : 'codec-explicit-retry-refusal', {
      body: await page.screenshot(), contentType: 'image/png',
    });
  }
});

test('convert-to-mp4: its VP8 example also isolates a blocked capability query', async ({ page, context }) => {
  await codecWorkerFixture(context, workerFilename, 'blocking');
  await page.goto('/convert-to-mp4/');
  const clickTarget = await prepareCodecResponsiveness(page);
  await page.evaluate(async () => {
    const url = '/convert-to-mp4/src/example.js';
    const { makeExample } = await import(url);
    const state = { done: false, error: null } as any;
    (window as any).__codecExample = state;
    void makeExample('bounded-example.webm', { width: 320, height: 240, fps: 1, seconds: 1 })
      .catch((error: Error) => { state.error = error.message; })
      .finally(() => { state.done = true; });
  });
  await expect.poll(async () => (await codecState(page)).workers[0]?.queries).toEqual(['vp8']);
  await responsiveDuringCodecQuery(page, clickTarget);
  await expect.poll(() => page.evaluate(() => (window as any).__codecExample.done), { timeout: 8_000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__codecExample.error)).toBe('example.novp8');
  await onlyWorkerQueries(page, 'convert-to-mp4', ['vp8']);
});

test('images-to-video: a missing codec worker refuses without a main-thread fallback and can be retried', async ({ page, context }) => {
  await codecWorkerFixture(context, workerFilename, 'missing');
  await loadImages(page);
  for (const attempt of [1, 2]) {
    await page.locator('#export').click();
    await refusedExport(page);
    const state = await codecState(page);
    expect(state.workers).toHaveLength(attempt);
    expect(state.workers.every((worker) => worker.queries.length === 0)).toBe(true);
  }
});
