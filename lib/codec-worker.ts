import { expect, type BrowserContext, type Page } from '@playwright/test';

export type CodecFixtureMode = 'blocking' | 'supported' | 'missing';

/** Keep the real worker, CSP and protocol around a controlled codec query. */
export async function codecWorkerFixture(
  context: BrowserContext,
  workerFilename: string,
  mode: CodecFixtureMode,
) {
  await context.addInitScript(({ workerFilename }) => {
    // This fixture replaces the codec with safe JavaScript, so it explicitly
    // exercises the normal worker path without Linux media initialization.
    // Unmodified runtime coverage is separate in codec-native-initialization.spec.ts.
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
    const state = {
      mainQueries: 0, encoderConstructions: 0, ticks: 0,
      workers: [] as Array<{ url: string; terminated: boolean; queries: string[] }>,
    };
    (window as any).__codecWorkerQA = state;
    setInterval(() => { state.ticks++; }, 25);
    class MainEncoder {
      constructor() { state.encoderConstructions++; throw new Error('The fixture must never encode.'); }
      static async isConfigSupported() { state.mainQueries++; return { supported: false }; }
    }
    Object.defineProperty(window, 'VideoEncoder', { configurable: true, value: MainEncoder });
    if (typeof (window as any).AudioEncoder !== 'function') {
      Object.defineProperty(window, 'AudioEncoder', {
        configurable: true, value: class { constructor() { throw new Error('Unexpected audio encoding.'); } },
      });
    }
    // The refusal path stops before constructing frames. A missing frame API
    // must not bypass the question whose isolation this fixture is checking.
    if (typeof (window as any).VideoFrame !== 'function') {
      Object.defineProperty(window, 'VideoFrame', {
        configurable: true, value: class { constructor() { throw new Error('Unexpected frame construction.'); } },
      });
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: undefined });
    const NativeWorker = window.Worker;
    class ObservedWorker extends NativeWorker {
      private entry: { url: string; terminated: boolean; queries: string[] } | undefined;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const resolved = new URL(String(url), location.href);
        if (resolved.pathname.endsWith(`/${workerFilename}`)) {
          this.entry = { url: resolved.href, terminated: false, queries: [] };
          state.workers.push(this.entry);
          this.addEventListener('message', (event) => {
            if (event.data?.__qaCodecQuery !== true) return;
            // The marker observes entry into the blocking call; it is not a
            // capability response and must not settle the production request.
            event.stopImmediatePropagation();
            this.entry!.queries.push(event.data.codec);
          });
        }
      }
      terminate() {
        if (this.entry) this.entry.terminated = true;
        return super.terminate();
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: ObservedWorker });
  }, { workerFilename });

  await context.route((url) => url.pathname.endsWith(`/${workerFilename}`), async (route) => {
    if (mode === 'missing') {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Missing test worker' });
      return;
    }
    const response = await route.fetch();
    expect(response.status(), 'The deployed same-origin worker asset must exist').toBe(200);
    const source = await response.text();
    const fixture = `
      Object.defineProperty(self, 'VideoEncoder', { configurable: true, value: class {
        static isConfigSupported(config) {
          self.postMessage({ __qaCodecQuery: true, codec: config.codec });
          if (${JSON.stringify(mode)} === 'blocking') {
            // A synchronous stall, not an unresolved promise. It ends itself
            // if cleanup regresses, but the page must terminate it far earlier.
            const until = performance.now() + 15000;
            while (performance.now() < until) {}
            return Promise.resolve({ supported: false });
          }
          return Promise.resolve({ supported: config.codec === 'avc1.640033' });
        }
      }});
    `;
    await route.fulfill({ response, body: `${fixture}\n${source}` });
  });
}

export async function codecState(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).__codecWorkerQA;
    return {
      mainQueries: state.mainQueries, encoderConstructions: state.encoderConstructions,
      ticks: state.ticks, workers: state.workers,
    };
  });
}

/** Establish layout and a genuine baseline click before starting the probe. */
export async function prepareCodecResponsiveness(page: Page) {
  await page.evaluate(() => {
    document.querySelector('#qa-codec-responsive')?.remove();
    const state = {
      armedAt: null as number | null,
      clicks: [] as Array<{ trusted: boolean; elapsed: number | null; activeWorker: boolean }>,
    };
    (window as any).__codecResponsiveness = state;
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'qa-codec-responsive';
    button.textContent = 'Check responsiveness';
    // A fixed box avoids font, hover and layout changes becoming part of the
    // response measurement. The tool keeps all of its own styles and motion.
    button.style.cssText = 'all:initial;display:block;position:fixed;top:4px;left:4px;'
      + 'width:190px;height:44px;box-sizing:border-box;z-index:2147483647;'
      + 'font:14px sans-serif;text-align:center;background:white;color:black;'
      + 'border:1px solid black;pointer-events:auto;touch-action:manipulation';
    button.onclick = (event) => {
      state.clicks.push({
        trusted: event.isTrusted,
        elapsed: state.armedAt === null ? null : performance.now() - state.armedAt,
        activeWorker: (window as any).__codecWorkerQA.workers.some(
          (worker: { terminated: boolean; queries: string[] }) => !worker.terminated && worker.queries.length > 0),
      });
      button.dataset.clicks = String(state.clicks.length);
    };
    document.body.append(button);
  });
  const button = page.locator('#qa-codec-responsive');
  await button.click({ timeout: 5_000 });
  await expect(button).toHaveAttribute('data-clicks', '1');
  expect(await page.evaluate(() => (window as any).__codecResponsiveness.clicks[0]))
    .toEqual({ trusted: true, elapsed: null, activeWorker: false });
  const box = await button.boundingBox();
  expect(box, 'The baseline click target must have a stable visible box').not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** A timer and a genuine click must remain live while the worker is blocked. */
export async function responsiveDuringCodecQuery(page: Page, point: { x: number; y: number }) {
  const before = await page.evaluate(({ x, y }) => {
    const state = (window as any).__codecResponsiveness;
    const codec = (window as any).__codecWorkerQA;
    state.armedAt = performance.now();
    return {
      ticks: codec.ticks, clicks: state.clicks.length,
      hitTarget: document.elementFromPoint(x, y) === document.querySelector('#qa-codec-responsive'),
      activeWorker: codec.workers.some(
        (worker: { terminated: boolean; queries: string[] }) => !worker.terminated && worker.queries.length > 0),
    };
  }, point);
  expect(before.hitTarget, 'The prepared button must still receive the measured pointer input').toBe(true);
  expect(before.activeWorker, 'Responsiveness must be measured before the worker deadline ends the query').toBe(true);

  // Layout/actionability was proved by the baseline click. Dispatch real input
  // to that same hit-tested box without spending the measured second waiting
  // for a freshly inserted element's first animation frames or scrolling.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      page.mouse.click(point.x, point.y),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Prepared pointer input did not complete within 1000ms')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await expect(page.locator('#qa-codec-responsive')).toHaveAttribute('data-clicks', String(before.clicks + 1), { timeout: 1_000 });
  const click = await page.evaluate(() => (window as any).__codecResponsiveness.clicks.at(-1));
  expect(click.trusted).toBe(true);
  expect(click.activeWorker, 'The click must arrive during the synchronous worker query').toBe(true);
  expect(click.elapsed).toBeLessThan(1_000);
  await expect.poll(() => page.evaluate((ticks) => {
    const codec = (window as any).__codecWorkerQA;
    return {
      progressed: codec.ticks > ticks,
      activeWorker: codec.workers.some(
        (worker: { terminated: boolean; queries: string[] }) => !worker.terminated && worker.queries.length > 0),
    };
  }, before.ticks), { timeout: 1_000, intervals: [25, 50, 100] })
    .toEqual({ progressed: true, activeWorker: true });
  await page.locator('#qa-codec-responsive').evaluate((button) => button.remove());
}
