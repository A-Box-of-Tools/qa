import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from '../../lib/site';

const available = fs.existsSync(path.join(ETOOLBOX_DIR, 'shared', 'js', 'codec-support-worker.js'));

// This is an independent engine diagnostic, not a capability gate for the
// product regressions in codec-worker.spec.ts. A process crash stays visible.
test.describe('images-to-video: independent native worker diagnostic', () => {
  test.describe.configure({ retries: 0 });
  test('records whether the native encoder answers, stalls in its worker, or crashes its process', async ({ browser, baseURL }, testInfo) => {
    test.skip(!available, 'Worker-isolated H.264 capability checks are awaiting the website release.');
    test.setTimeout(45_000);
    const own = await browser.browserType().launch();
    const evidence: any = {
      engine: own.browserType().name(), version: own.version(), project: testInfo.project.name,
      native: true, pageCode: 'independent blank page', workerCode: 'independent native query',
      queryPosted: false, queryEntered: false, heartbeats: 0, pageCrashed: false,
    };
    let result: any;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const context = await own.newContext();
      const pageURL = new URL('/images-to-video/?qa-native-codec=1', baseURL).href;
      const workerURL = new URL('/images-to-video/qa-native-codec-worker.js', baseURL).href;
      await context.route(pageURL, async (route) => {
        const response = await route.fetch();
        expect(response.status(), 'The diagnostic must inherit a real deployed tool response').toBe(200);
        const html = await response.text();
        const policies = html.match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? [];
        await route.fulfill({ response, body: `<!doctype html><html><head>${policies.join('')}</head><body>Native codec diagnostic</body></html>` });
      });
      await context.route(workerURL, (route) => route.fulfill({
        status: 200, contentType: 'application/javascript', body: `
          self.onmessage = async ({ data }) => {
            if (typeof self.VideoEncoder?.isConfigSupported !== 'function') {
              self.postMessage({ kind: 'unavailable' });
              return;
            }
            self.postMessage({ kind: 'entered' });
            try {
              const answer = await self.VideoEncoder.isConfigSupported(data);
              self.postMessage({ kind: 'answered', supported: answer?.supported === true });
            } catch (error) {
              self.postMessage({ kind: 'rejected', name: error?.name || 'Error' });
            }
          };
        `,
      }));
      const page = await context.newPage();
      let crashed!: (value: any) => void;
      const crash = new Promise((resolve) => { crashed = resolve; });
      page.on('crash', () => {
        evidence.pageCrashed = true;
        crashed({ outcome: 'process-crashed' });
      });
      await page.exposeFunction('__qaNativeProgress', (update: any) => {
        if (update.entered) evidence.queryEntered = true;
        if (Number.isInteger(update.heartbeats)) evidence.heartbeats = update.heartbeats;
        if (update.posted) evidence.queryPosted = true;
      });
      await page.goto(pageURL);
      evidence.publicNavigator = await page.evaluate(() => ({
        userAgent: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor,
      }));
      const work = page.evaluate((workerURL) => new Promise((resolve) => {
        let ticks = 0;
        let entered = false;
        let settled = false;
        const start = performance.now();
        const worker = new Worker(workerURL, { type: 'module' });
        const heartbeat = setInterval(() => {
          ticks++;
          void (window as any).__qaNativeProgress({ heartbeats: ticks });
        }, 100);
        const finish = (outcome: string, extra: object = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); clearInterval(heartbeat);
          worker.terminate();
          resolve({ outcome, entered, ticks, terminated: true, elapsed: performance.now() - start, ...extra });
        };
        const timer = setTimeout(() => finish(entered ? 'stalled-responsive' : 'worker-no-entry'), 3_000);
        worker.onmessage = ({ data }) => {
          if (data.kind === 'entered') {
            entered = true;
            void (window as any).__qaNativeProgress({ entered: true });
          } else if (data.kind === 'unavailable') finish('unavailable');
          else if (data.kind === 'answered') finish(data.supported ? 'supported' : 'unsupported');
          else if (data.kind === 'rejected') finish('query-rejected', { errorName: data.name });
        };
        worker.onerror = (event) => {
          event.preventDefault();
          finish('worker-error', { message: event.message });
        };
        // Record the boundary outside this renderer before invoking the
        // native query, so a process crash cannot erase that observation.
        void (window as any).__qaNativeProgress({ posted: true }).then(() => {
          if (!settled) worker.postMessage({
            codec: 'avc1.640034', width: 320, height: 240, framerate: 30,
            bitrate: 1_200_000, avc: { format: 'avc' },
          });
        }).catch((error: Error) => finish('progress-error', { message: error.message }));
      }), workerURL).catch((error) => ({ outcome: evidence.pageCrashed ? 'process-crashed' : 'evaluation-error', message: error.message }));
      result = await Promise.race([
        work, crash,
        new Promise((resolve) => { deadline = setTimeout(() => resolve({ outcome: 'parent-unresponsive' }), 10_000); }),
      ]);
    } finally {
      clearTimeout(deadline);
      await own.close();
      evidence.result = result ?? { outcome: 'setup-error' };
      await testInfo.attach('independent-native-codec-worker', {
        body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json',
      });
    }
    testInfo.annotations.push({ type: 'native-codec-worker', description: result.outcome });
    const identity = evidence.publicNavigator;
    const guardedRuntime = identity && /^Linux\b/i.test(identity.platform)
      && identity.vendor === 'Apple Computer, Inc.' && /\bAppleWebKit\//.test(identity.userAgent)
      && !/\b(?:Chromium|Chrome|CriOS|Edg|EdgA|EdgiOS|OPR|Firefox|FxiOS)\//.test(identity.userAgent);
    // The independent query deliberately bypasses the product guard. Keep
    // this engine failure visible and make a native recovery an unexpected
    // pass, which signals that the conservative guard needs reconsideration.
    // A setup failure before native query entry does not qualify.
    const nativeObservation = evidence.queryEntered && [
      'supported', 'unsupported', 'query-rejected', 'stalled-responsive', 'parent-unresponsive', 'process-crashed',
    ].includes(result.outcome);
    test.fail(guardedRuntime && nativeObservation,
      'Known Linux WebKit native encoder failure (website #317); the unmodified product path must refuse before this query. A native pass requires reviewing the guard.');
    test.skip(result.outcome === 'unavailable', 'This independent native worker has no VideoEncoder capability API; native Safari encoding remains unverified.');
    test.skip(!guardedRuntime && result.outcome === 'process-crashed' && evidence.queryPosted,
      'The independent native query crashed its browser process; a worker cannot contain this engine-wide failure. Native Safari remains unverified.');
    expect(['supported', 'unsupported', 'query-rejected', 'stalled-responsive']).toContain(result.outcome);
    expect(result.terminated).toBe(true);
    if (result.outcome === 'stalled-responsive') {
      expect(result.entered).toBe(true);
      expect(result.ticks).toBeGreaterThan(0);
    }
  });
});
