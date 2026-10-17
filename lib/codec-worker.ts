import { expect, type BrowserContext, type Page } from '@playwright/test';

export type CodecFixtureMode = 'blocking' | 'supported' | 'missing';

/** Keep the real worker, CSP and protocol, replacing only the platform query. */
export async function codecWorkerFixture(
  context: BrowserContext,
  workerFilename: string,
  mode: CodecFixtureMode,
) {
  await context.addInitScript(({ workerFilename }) => {
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

/** A timer and a genuine click must remain live while the worker is blocked. */
export async function responsiveDuringCodecQuery(page: Page) {
  const before = (await codecState(page)).ticks;
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'qa-codec-responsive';
    button.textContent = 'Check responsiveness';
    button.style.cssText = 'position:fixed;top:4px;left:4px;z-index:2147483647';
    button.onclick = () => { button.dataset.clicked = 'yes'; };
    document.body.append(button);
  });
  await page.locator('#qa-codec-responsive').click({ timeout: 1_000 });
  await expect(page.locator('#qa-codec-responsive')).toHaveAttribute('data-clicked', 'yes');
  await expect.poll(async () => (await codecState(page)).ticks, { timeout: 1_000 }).toBeGreaterThan(before);
  await page.locator('#qa-codec-responsive').evaluate((button) => button.remove());
}
