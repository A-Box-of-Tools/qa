import { test, expect, devices } from '@playwright/test';
import os from 'node:os';

const full = { codec: 'avc1.640034', width: 320, height: 240, framerate: 30, bitrate: 1_200_000, avc: { format: 'avc' } };
const minimal = { codec: full.codec, width: full.width, height: full.height };
const variants = [
  { name: 'high-full', configs: [full] },
  { name: 'high-software', configs: [{ ...full, hardwareAcceleration: 'prefer-software' }] },
  { name: 'baseline-full', configs: [{ ...full, codec: 'avc1.42001f' }] },
  { name: 'high-minimal', configs: [minimal] },
  { name: 'high-minimal-then-full', configs: [minimal, full] },
];

test('runtime-identity: public navigator strings in default and emulated contexts', async ({ playwright, browserName, baseURL }, testInfo) => {
  const own = await playwright[browserName].launch();
  const evidence: any = { engine: browserName, browserVersion: own.version(), runnerPlatform: os.platform(), runnerRelease: os.release(), runnerArchitecture: os.arch(), contexts: [] };
  try {
    for (const profile of ['default', 'Desktop Safari', 'iPhone 13']) {
      const device = profile === 'default' ? {} : devices[profile];
      const { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch } = device;
      const context = await own.newContext(profile === 'default' ? {} : { userAgent, viewport, deviceScaleFactor, isMobile, hasTouch });
      const page = await context.newPage();
      await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Identity only</title>' }));
      await page.goto(new URL('/images-to-video/?qa-identity=1', baseURL).href);
      const identity = await page.evaluate(() => ({
        userAgent: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor,
        maxTouchPoints: navigator.maxTouchPoints,
        userAgentData: (navigator as any).userAgentData?.toJSON?.() ?? null,
      }));
      evidence.contexts.push({ configuredProfile: profile, configuredUserAgent: userAgent ?? null, publicNavigator: identity });
      await context.close();
    }
  } finally {
    await own.close();
    await testInfo.attach('native-runtime-identity', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
    console.log(JSON.stringify(evidence));
  }
  expect(evidence.contexts).toHaveLength(3);
});

for (const type of ['module', 'classic'] as const) for (const variant of variants) {
  test(`${type}: ${variant.name}`, async ({ playwright, browserName, baseURL }, testInfo) => {
    // Every question receives a new native browser process. A failed native
    // query cannot poison the engine used to ask the next question.
    const own = await playwright[browserName].launch();
    const evidence: any = {
      engine: browserName, browserVersion: own.version(), platform: os.platform(),
      release: os.release(), architecture: os.arch(), actualSafari: false,
      workerType: type, variant: variant.name, configs: variant.configs,
      phases: [], heartbeats: 0, pageCrashed: false,
    };
    let result: any;
    let outer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context = await own.newContext();
      const pageURL = new URL('/images-to-video/?qa-native-experiment=1', baseURL).href;
      const workerURL = new URL('/images-to-video/qa-native-experiment.js', baseURL).href;
      await context.route(pageURL, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const policies = (await response.text()).match(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi) ?? [];
        await route.fulfill({ response, body: `<!doctype html><html><head>${policies.join('')}</head><body>Independent native codec experiment</body></html>` });
      });
      await context.route(workerURL, (route) => route.fulfill({
        status: 200, contentType: 'application/javascript', body: `
          self.onmessage = async ({data}) => {
            if (data.kind === 'ping') { self.postMessage({kind:'pong'}); return; }
            if (typeof self.VideoEncoder?.isConfigSupported !== 'function') {
              self.postMessage({kind:'unavailable'}); return;
            }
            for (let index = 0; index < data.configs.length; index++) {
              self.postMessage({kind:'entered', index});
              try {
                const answer = await self.VideoEncoder.isConfigSupported(data.configs[index]);
                self.postMessage({kind:'answered', index, supported: answer?.supported === true});
                if (!answer?.supported) { self.postMessage({kind:'finished', outcome:'unsupported'}); return; }
              } catch(error) {
                self.postMessage({kind:'finished', outcome:'query-rejected', name:error?.name || 'Error'}); return;
              }
            }
            self.postMessage({kind:'finished', outcome:'supported'});
          };
        `,
      }));
      const page = await context.newPage();
      let crashed!: (value: any) => void;
      const crash = new Promise(resolve => { crashed = resolve; });
      page.on('crash', () => { evidence.pageCrashed = true; crashed({ outcome: 'process-crashed' }); });
      await page.exposeFunction('__qaProgress', (update: any) => {
        if (update.phase) evidence.phases.push(update);
        if (Number.isInteger(update.heartbeats)) evidence.heartbeats = update.heartbeats;
      });
      await page.goto(pageURL);
      evidence.publicNavigator = await page.evaluate(() => ({
        userAgent: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor,
        maxTouchPoints: navigator.maxTouchPoints,
        userAgentData: (navigator as any).userAgentData?.toJSON?.() ?? null,
      }));
      const work = page.evaluate(({ workerURL, type, configs }) => new Promise(resolve => {
        const report = (update: any) => (window as any).__qaProgress(update);
        let settled = false;
        let ticks = 0;
        let healthy = false;
        let entered = false;
        let timer: ReturnType<typeof setTimeout>;
        const start = performance.now();
        const worker = new Worker(workerURL, { type });
        const heartbeat = setInterval(() => { ticks++; void report({ heartbeats: ticks }); }, 100);
        const finish = async (outcome: string, extra: object = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); clearInterval(heartbeat);
          // The bridge resolves only once Node has recorded each boundary.
          // This separates a blocked parent from terminate() itself blocking.
          await report({ phase: 'before-terminate', outcome, elapsed: performance.now() - start });
          worker.terminate();
          await report({ phase: 'after-terminate', outcome, elapsed: performance.now() - start });
          resolve({ outcome, healthy, entered, ticks, terminated: true, ...extra });
        };
        const arm = (phase: string) => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            await report({ phase: 'deadline-fired', during: phase, ticks, elapsed: performance.now() - start });
            await finish(healthy && entered ? 'stalled-responsive' : 'preflight-failed');
          }, 3_000);
        };
        arm('healthy-ping');
        worker.onmessage = async ({ data }) => {
          await report({ phase: data.kind, ...data, elapsed: performance.now() - start });
          if (data.kind === 'pong') {
            healthy = true;
            arm('native-query');
            await report({ phase: 'query-posted' });
            if (!settled) worker.postMessage({ kind: 'query', configs });
          } else if (data.kind === 'entered') entered = true;
          else if (data.kind === 'unavailable') await finish('unavailable');
          else if (data.kind === 'finished') await finish(data.outcome, { errorName: data.name });
        };
        worker.onerror = event => { event.preventDefault(); void finish('worker-error', { message: event.message }); };
        worker.postMessage({ kind: 'ping' });
      }), { workerURL, type, configs: variant.configs }).catch(error => ({ outcome: evidence.pageCrashed ? 'process-crashed' : 'evaluation-error', message: error.message }));
      result = await Promise.race([
        work, crash,
        new Promise(resolve => { outer = setTimeout(() => resolve({ outcome: 'outer-deadline' }), 12_000); }),
      ]);
    } finally {
      clearTimeout(outer);
      evidence.result = result ?? { outcome: 'setup-error' };
      await testInfo.attach('native-codec-phases', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
      console.log(JSON.stringify(evidence));
      await own.close();
    }
    expect(['supported', 'unsupported', 'query-rejected', 'stalled-responsive']).toContain(result.outcome);
    expect(result.healthy).toBe(true);
    expect(result.terminated).toBe(true);
    expect(evidence.phases.some((event: any) => event.phase === 'after-terminate')).toBe(true);
  });
}
