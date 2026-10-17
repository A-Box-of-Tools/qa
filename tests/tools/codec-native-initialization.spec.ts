import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from '../../lib/site';
import { isMp4, readMp4, videoTrack } from '../../lib/mp4';

const available = fs.existsSync(path.join(ETOOLBOX_DIR, 'shared', 'js', 'codec-support-worker.js'));
const tools = [
  'images-to-video', 'reverse-video', 'timelapse-video', 'crop-video', 'trim-video',
  'compress-video', 'convert-to-mp4', 'extract-audio-from-video', 'gif-to-mp4',
  'grab-frame', 'rotate-video', 'video-to-gif',
];

test.beforeEach(() => {
  test.skip(!available, 'Worker-isolated H.264 capability checks are awaiting the website release.');
});

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(`Native codec operation exceeded its external ${milliseconds}ms deadline`)), milliseconds);
    })]);
  } finally { clearTimeout(deadline); }
}

async function observeNativePage(context: BrowserContext, page: Page, slug: string) {
  await context.addInitScript(() => {
    const state = { workers: [] as any[], events: [] as any[], ticks: 0, clicks: 0 };
    (window as any).__nativeCodecQA = state;
    setInterval(() => { state.ticks++; }, 25);
    // Observe, but never replace the native answer or initialize media on the
    // fixture's behalf. A missing product initialization still reaches the bug.
    const canPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type: string) {
      const result = canPlayType.call(this, type);
      state.events.push({ kind: 'can-play-type', type, result });
      return result;
    };
    const NativeWorker = window.Worker;
    Object.defineProperty(window, 'Worker', { configurable: true, value: class extends NativeWorker {
      entry: any;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.entry = { url: String(url), terminated: false, queries: [], replies: [] };
        state.events.push({ kind: 'worker', url: String(url) });
        state.workers.push(this.entry);
        this.addEventListener('message', event => this.entry.replies.push(event.data));
      }
      postMessage(data: any, transferOrOptions?: any) {
        this.entry.queries.push(data);
        return super.postMessage(data, transferOrOptions);
      }
      terminate() { super.terminate(); this.entry.terminated = true; }
    } });
  });
  await page.goto(`/${slug}/`);
  const identity = await page.evaluate(() => ({
    platform: navigator.platform, vendor: navigator.vendor, userAgent: navigator.userAgent,
  }));
  expect(await page.evaluate(() => typeof (globalThis as any).VideoEncoder?.isConfigSupported)).toBe('function');
  expect(await page.evaluate(() => typeof (globalThis as any).VideoFrame)).toBe('function');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'qa-native-responsive'; button.type = 'button'; button.textContent = 'Check page responsiveness';
    button.style.cssText = 'all:initial;display:block;position:fixed;top:4px;left:4px;'
      + 'z-index:2147483647;width:210px;height:44px;box-sizing:border-box;'
      + 'font:14px sans-serif;text-align:center;background:white;color:black;'
      + 'border:1px solid black;pointer-events:auto;touch-action:manipulation';
    button.onclick = event => {
      const state = (window as any).__nativeCodecQA;
      if (event.isTrusted) state.clicks++;
      state.lastClick = { trusted: event.isTrusted, elapsed: state.armedAt == null ? null : performance.now() - state.armedAt };
    };
    document.body.append(button);
  });
  await page.locator('#qa-native-responsive').click();
  expect(await page.evaluate(() => (window as any).__nativeCodecQA.clicks)).toBe(1);
  const box = await page.locator('#qa-native-responsive').boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(point => { (window as any).__nativeCodecQA.point = point; },
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  return identity;
}

async function responsiveAfterWorker(page: Page, expectedWorkers: number, identity: any) {
  const before = await bounded(page.evaluate(() => {
    const state = (window as any).__nativeCodecQA;
    state.armedAt = performance.now();
    return { ...state, hitTarget: document.elementFromPoint(state.point.x, state.point.y) === document.querySelector('#qa-native-responsive') };
  }), 2_000);
  expect(before.workers).toHaveLength(expectedWorkers);
  for (const worker of before.workers) {
    expect(worker.terminated).toBe(true);
    expect(worker.queries).toHaveLength(1);
    expect(worker.queries[0].codec).toBe('VideoEncoder');
    expect(worker.replies.some((reply: any) => Number.isInteger(reply.index) && reply.index >= 0)).toBe(true);
  }
  const affectedRuntime = /^Linux\b/i.test(identity.platform)
    && identity.vendor === 'Apple Computer, Inc.' && /\bAppleWebKit\//.test(identity.userAgent)
    && !/\b(?:Chromium|Chrome|CriOS|Edg|EdgA|EdgiOS|OPR|Firefox|FxiOS)\//.test(identity.userAgent);
  if (affectedRuntime) {
    const firstWorker = before.events.findIndex((event: any) => event.kind === 'worker');
    expect(before.events.slice(0, firstWorker).some((event: any) => event.kind === 'can-play-type'),
      'The product must initialize native media on its page before asking the worker').toBe(true);
  }
  expect(before.hitTarget).toBe(true);
  await bounded(page.mouse.click(before.point.x, before.point.y), 2_000);
  await expect.poll(() => page.evaluate(() => (window as any).__nativeCodecQA.ticks), { timeout: 2_000 }).toBeGreaterThan(before.ticks);
  const after = await page.evaluate(() => (window as any).__nativeCodecQA);
  expect(after.clicks).toBe(before.clicks + 1);
  expect(after.lastClick.trusted).toBe(true);
  expect(after.lastClick.elapsed).toBeLessThan(2_000);
}

for (const slug of tools) {
  test(`${slug}: native codec initialization preserves H.264 support and responsive retry`, async ({ page, context }, testInfo) => {
    const identity = await observeNativePage(context, page, slug);
    await testInfo.attach('unmodified-native-runtime', { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json' });
    const modulePath = slug === 'images-to-video' ? 'support.js' : 'shared/video-support.js';
    for (const attempt of [1, 2]) {
      const codec = await bounded(page.evaluate(async ({ slug, modulePath }) => {
        const { pickH264Codec } = await import(`/${slug}/src/${modulePath}`);
        return pickH264Codec({ width: 320, height: 240, framerate: 30, bitrate: 1_200_000 });
      }, { slug, modulePath }), 5_000);
      expect(codec, `Native attempt ${attempt} must preserve the working encoder`).toMatch(/^avc1\./);
      await responsiveAfterWorker(page, attempt, identity);
    }
  });
}

test('images-to-video: native initialization produces a playable MP4 and permits another real export', async ({ page, context }, testInfo) => {
  // Two complete exports include playback, real downloads and evidence capture.
  // Keep their phase deadlines while allowing both journeys to finish on WebKit.
  test.setTimeout(90_000);
  const identity = await observeNativePage(context, page, 'images-to-video');
  await testInfo.attach('unmodified-native-runtime', { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json' });
  await page.getByRole('button', { name: /try (an )?example/i }).click();
  await expect(page.locator('#image-list li')).toHaveCount(12);
  // Twelve frames at 30fps are the real example's default output contract.
  for (const attempt of [1, 2]) {
    await bounded((async () => {
      await page.locator('#export').click();
      await expect(page.locator('#result')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#error')).toBeHidden();
      await expect(page.locator('#progress')).toBeHidden();
      await expect(page.locator('#export')).toBeEnabled();
      await page.waitForFunction(() => {
        const video = document.querySelector<HTMLVideoElement>('#result-video')!;
        return video.readyState >= 2 && video.videoWidth > 0 && Number.isFinite(video.duration) && video.duration > 0;
      }, undefined, { timeout: 10_000 });
    })(), 15_000);
    const playback = await bounded(page.locator('#result-video').evaluate(async element => {
      const video = element as HTMLVideoElement;
      video.muted = true; await video.play();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Generated video did not advance')), 3_000);
        const observe = () => {
          if (video.currentTime <= 0) return;
          clearTimeout(deadline); video.removeEventListener('timeupdate', observe); resolve();
        };
        video.addEventListener('timeupdate', observe); observe();
      });
      video.pause();
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime };
    }), 5_000);
    expect(playback.width).toBe(1280); expect(playback.height).toBe(720);
    expect(playback.duration).toBeCloseTo(12 / 30, 2);
    expect(playback.currentTime).toBeGreaterThan(0);
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#download').click();
    const download = await downloadEvent;
    const saved = await download.path(); expect(saved).not.toBeNull();
    const bytes = fs.readFileSync(saved!);
    expect(isMp4(bytes)).toBe(true); expect(bytes.length).toBeGreaterThan(1000);
    const track = videoTrack(readMp4(bytes));
    expect(track).toMatchObject({ codec: 'avc1', width: 1280, height: 720, samples: 12 });
    expect(track!.seconds).toBeCloseTo(12 / 30, 2);
    expect(download.suggestedFilename()).toMatch(/\.mp4$/);
    await expect(page.locator('#image-list li')).toHaveCount(12);
    await responsiveAfterWorker(page, attempt, identity);
    await testInfo.attach(`native-mp4-${attempt}`, { body: bytes, contentType: 'video/mp4' });
    await testInfo.attach(`native-output-${attempt}`, { body: Buffer.from(JSON.stringify({ playback, bytes: bytes.length, track })), contentType: 'application/json' });
    await testInfo.attach(`native-output-screen-${attempt}`, { body: await page.screenshot(), contentType: 'image/png' });
  }
});

test('convert-to-mp4: native initialization preserves the VP8 example and a fresh retry', async ({ page, context }, testInfo) => {
  const identity = await observeNativePage(context, page, 'convert-to-mp4');
  await testInfo.attach('unmodified-native-runtime', { body: Buffer.from(JSON.stringify(identity)), contentType: 'application/json' });
  expect(await page.evaluate(() => typeof (globalThis as any).AudioEncoder)).toBe('function');
  for (const attempt of [1, 2]) {
    const output = await bounded(page.evaluate(async () => {
      const { makeExample } = await import('/convert-to-mp4/src/example.js');
      const file = await makeExample('native-example.webm', { width: 320, height: 240, fps: 1, seconds: 1 });
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { size: file.size, type: file.type, name: file.name, header: Array.from(bytes.slice(0, 4)) };
    }), 10_000);
    expect(output).toMatchObject({ type: 'video/webm', name: 'native-example.webm', header: [0x1a, 0x45, 0xdf, 0xa3] });
    expect(output.size).toBeGreaterThan(100);
    await responsiveAfterWorker(page, attempt, identity);
  }
});
