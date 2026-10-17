import { test, expect, devices } from '@playwright/test';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

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

const experiments = [
  ...(['module', 'classic'] as const).flatMap(type => variants.map(variant => ({ type, ...variant, warmRecorder: false, scope: 'native' }))),
  { type: 'module' as const, name: 'crop-exact-cold', configs: [{ ...full, width: 240, height: 160, framerate: 20, bitrate: 200_000 }], warmRecorder: false, scope: 'crop' },
  { type: 'module' as const, name: 'known-cold', configs: [full], warmRecorder: false, scope: 'crop' },
  { type: 'module' as const, name: 'known-after-native-recorder', configs: [full], warmRecorder: true, scope: 'crop' },
  { type: 'module' as const, name: 'known-after-can-play-type', configs: [full], warmRecorder: false, warmCanPlay: true, scope: 'app' },
];

for (const variant of experiments) {
  const { type } = variant;
  test(`${variant.scope}: ${type}: ${variant.name}`, async ({ playwright, browserName, baseURL }, testInfo) => {
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
      if ('warmCanPlay' in variant && variant.warmCanPlay) {
        let warmDeadline: ReturnType<typeof setTimeout> | undefined;
        evidence.canPlayWarmup = await Promise.race([
          page.evaluate(() => ({ result: document.createElement('video').canPlayType('video/mp4; codecs="avc1.640034"') })),
          new Promise(resolve => { warmDeadline = setTimeout(() => resolve({ outcome: 'warmup-outer-deadline' }), 5_000); }),
        ]);
        clearTimeout(warmDeadline);
        if (evidence.canPlayWarmup.outcome === 'warmup-outer-deadline') throw new Error('canPlayType warm-up exceeded its external deadline.');
      }
      if (variant.warmRecorder) {
        let warmDeadline: ReturnType<typeof setTimeout> | undefined;
        evidence.recorderWarmup = await Promise.race([
          page.evaluate(async () => {
            if (typeof MediaRecorder !== 'function') return { outcome: 'unavailable', available: false };
            const mimeType = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
            if (!mimeType) return { outcome: 'no-supported-mime', available: true };
            const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
            const drawing = canvas.getContext('2d')!;
            const stream = canvas.captureStream(20);
            const chunks: Blob[] = [];
            const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 });
            const done = new Promise<any>(resolve => {
              recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
              recorder.onstop = () => resolve({ outcome: 'recorded', available: true, mimeType: recorder.mimeType, bytes: chunks.reduce((sum, chunk) => sum + chunk.size, 0) });
              recorder.onerror = event => resolve({ outcome: 'recorder-error', available: true, name: (event as any).error?.name ?? 'Error' });
            });
            let frame = 0;
            const draw = setInterval(() => { drawing.fillStyle = frame++ % 2 ? 'red' : 'blue'; drawing.fillRect(0, 0, 320, 240); }, 40);
            try {
              recorder.start();
              await new Promise(resolve => setTimeout(resolve, 400));
              recorder.stop();
              return await done;
            } finally { clearInterval(draw); stream.getTracks().forEach(track => track.stop()); }
          }).catch(error => ({ outcome: 'warmup-error', message: error.message })),
          new Promise(resolve => { warmDeadline = setTimeout(() => resolve({ outcome: 'warmup-outer-deadline' }), 5_000); }),
        ]);
        clearTimeout(warmDeadline);
        // Absence is evidence too: a separate Chromium fixture generator cannot
        // warm the WebKit process that will receive this native question.
        if (evidence.recorderWarmup.outcome === 'warmup-outer-deadline') throw new Error('Native recorder warm-up exceeded its external deadline.');
      }
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

for (const warm of [false, true]) test(`${warm ? 'warm' : 'app'}: actual Images example and Create with only the Linux guard bypassed`, async ({ playwright, browserName, baseURL }, testInfo) => {
  const own = await playwright[browserName].launch();
  const evidence: any = { engine: browserName, browserVersion: own.version(), runnerPlatform: os.platform(), runnerRelease: os.release(), actualSafari: false, navigatorPlatformOverride: 'MacIntel', phases: [], heartbeats: 0 };
  let outer: ReturnType<typeof setTimeout> | undefined;
  let result: any;
  try {
    const context = await own.newContext();
    await context.exposeFunction('__qaNativeAppProgress', (update: any) => {
      if (update.phase) evidence.phases.push(update);
      if (Number.isInteger(update.ticks)) evidence.heartbeats = update.ticks;
    });
    await context.addInitScript(() => {
      // This experiment removes only the proposed Linux guard. All codec APIs,
      // settings, workers and output processing remain the production ones.
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      const report = (update: any) => (window as any).__qaNativeAppProgress(update);
      let ticks = 0;
      setInterval(() => { void report({ ticks: ++ticks }); }, 100);
      const NativeWorker = Worker;
      Object.defineProperty(window, 'Worker', { configurable: true, value: class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          void report({ phase: 'worker-created', url: String(url) });
          this.addEventListener('message', event => { void report({ phase: 'worker-reply', answer: event.data }); });
        }
        postMessage(data: any, transferOrOptions?: any) {
          void report({ phase: 'worker-query-posted', configs: data?.configs });
          return super.postMessage(data, transferOrOptions);
        }
        terminate() {
          void report({ phase: 'worker-terminate-called' });
          super.terminate();
          void report({ phase: 'worker-terminate-returned' });
        }
      } });
    });
    const page = await context.newPage();
    page.on('crash', () => { evidence.pageCrashed = true; });
    await page.goto(new URL('/images-to-video/', baseURL).href);
    evidence.nativeAPIs = await page.evaluate(() => ({ encoder: typeof VideoEncoder, frame: typeof VideoFrame, platform: navigator.platform }));
    if (warm) evidence.canPlayWarmup = await page.evaluate(() => ({ result: document.createElement('video').canPlayType('video/mp4; codecs="avc1.640034"') }));
    await page.getByRole('button', { name: /try (an )?example/i }).click();
    await expect(page.locator('#image-list li')).toHaveCount(12);
    const button = page.locator('#export');
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeEnabled();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest('#export') != null, point)).toBe(true);
    evidence.phases.push({ phase: 'before-create', ticks: evidence.heartbeats });
    const operation = (async () => {
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => !document.querySelector<HTMLElement>('#result')!.hidden || !document.querySelector<HTMLElement>('#error')!.hidden, undefined, { timeout: 12_000 });
      const visible = await page.evaluate(() => {
        const error = document.querySelector<HTMLElement>('#error')!;
        if (!error.hidden) return { outcome: 'readable-refusal', message: error.textContent };
        const link = document.querySelector<HTMLAnchorElement>('#download')!;
        const video = document.querySelector<HTMLVideoElement>('#result video');
        return { outcome: 'output', filename: link.download, width: video?.videoWidth, height: video?.videoHeight, duration: video?.duration };
      });
      if (visible.outcome !== 'output') return visible;
      const downloadEvent = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await downloadEvent;
      const path = await download.path();
      if (!path) return { outcome: 'download-missing' };
      const bytes = await readFile(path);
      await testInfo.attach('actual-images-output', { body: bytes, contentType: 'video/mp4' });
      return { ...visible, bytes: bytes.length, container: bytes.toString('ascii', 4, 8), suggestedFilename: download.suggestedFilename() };
    })().catch(error => ({ outcome: 'operation-error', message: error.message }));
    result = await Promise.race([operation, new Promise(resolve => { outer = setTimeout(() => resolve({ outcome: 'outer-deadline' }), 15_000); })]);
    if (result.outcome === 'output' || result.outcome === 'readable-refusal') await testInfo.attach('actual-images-result', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    clearTimeout(outer);
    evidence.result = result ?? { outcome: 'setup-error' };
    await testInfo.attach('native-codec-phases', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
    console.log(JSON.stringify(evidence));
    await own.close();
  }
  expect(result.outcome).toBe('output');
  expect(result.bytes).toBeGreaterThan(1000);
  expect(result.container).toBe('ftyp');
});
