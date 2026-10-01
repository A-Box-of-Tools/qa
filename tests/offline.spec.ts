import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { discoverTools } from '../lib/tools';
import { localeUrl } from '../lib/locales';
import { ask, withoutThirdParties } from '../lib/engine';

async function stopServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

type OfflineCapability = { supported: boolean; unsupported?: string; failure?: string };

async function canEmulateOfflineWorkerNavigation(page: Page): Promise<OfflineCapability> {
  // Playwright can reject a worker response before the worker handles it:
  // https://github.com/microsoft/playwright/issues/42775. Ask with an unrelated
  // cache-only worker, so a broken website can never remove its own checks.
  return ask<OfflineCapability>(page, 'offline-worker-navigation', async () => {
    const browser = page.context().browser();
    if (!browser) return { supported: false, failure: 'the probe has no browser' };
    const own = await browser.newContext({ serviceWorkers: 'allow' });
    const scratch = await own.newPage();
    scratch.setDefaultTimeout(5_000);
    scratch.setDefaultNavigationTimeout(5_000);
    const marker = 'independent cached worker response';
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.url === '/probe/sw.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(`self.addEventListener('install', event => event.waitUntil((async () => {
          const cache = await caches.open('qa-offline-probe');
          await cache.add('/probe/cached.html');
          await self.skipWaiting();
        })()));
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          if (event.request.mode === 'navigate') {
            event.respondWith(caches.open('qa-offline-probe').then(cache => cache.match('/probe/cached.html')));
          }
        });`);
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><title>Independent offline probe</title><main>${
          req.url === '/probe/cached.html' ? marker : 'origin response'
        }</main>`);
      }
    });
    const deadline = setTimeout(() => {
      void own.close().catch(() => {});
      void stopServer(server).catch(() => {});
    }, 20_000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await scratch.goto(`${origin}/probe/`);
      if (!await scratch.evaluate(() => 'serviceWorker' in navigator)) {
        return { supported: false, unsupported: 'the engine exposes no service-worker API' };
      }
      await scratch.evaluate(async () => {
        await navigator.serviceWorker.register('/probe/sw.js');
        await navigator.serviceWorker.ready;
      });
      await scratch.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await scratch.goto(`${origin}/probe/online-check`);
      if (await scratch.locator('main').textContent() !== marker) {
        return { supported: false, failure: 'the independent worker did not serve its cache while online' };
      }
      await own.setOffline(true);
      // A page outside the worker's scope must fail, or the browser was not
      // actually taken offline and a successful worker result proves nothing.
      const negative = await own.newPage();
      let networkRefused = false;
      try {
        await negative.goto(`${origin}/no-worker`, { timeout: 5_000 });
      } catch {
        networkRefused = true;
      } finally {
        await negative.close();
      }
      if (!networkRefused) return { supported: false, failure: 'offline emulation still reached the origin without a worker' };
      try {
        await scratch.goto(`${origin}/probe/offline-check`);
      } catch (error) {
        return { supported: false, unsupported: `offline emulation rejected the independent cache-only worker: ${String(error)}` };
      }
      if (await scratch.locator('main').textContent() !== marker) {
        return { supported: false, failure: 'offline emulation returned an unexpected independent response' };
      }
      return { supported: true };
    } finally {
      clearTimeout(deadline);
      try { await own.close(); } finally { await stopServer(server); }
    }
  }, { supported: false, failure: 'the independent offline probe failed or exceeded its deadline' }, 25_000);
}

async function controlled(page: Page, scope: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''),
    { timeout: 90_000, message: `${scope} never gained its own active offline worker` })
    .toContain(`${scope}sw.js`);
}

test.describe('offline: every tool keeps its installed page', () => {
  for (const slug of discoverTools()) {
    test(`${slug} reloads its own shell and modules without the network`, async ({ page, context }) => {
      test.setTimeout(150_000);
      const capability = await canEmulateOfflineWorkerNavigation(page);
      expect(capability.failure, capability.failure).toBeUndefined();
      test.skip(!capability.supported, capability.unsupported);
      await withoutThirdParties(page);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/${slug}/`);
      test.skip(!await page.evaluate(() => 'serviceWorker' in navigator),
        'this engine exposes no service-worker API; offline installation cannot run');
      await controlled(page, `/${slug}/`);
      const title = await page.title();
      const main = await page.locator('#main').innerText();
      await context.setOffline(true);
      try {
        await page.reload({ waitUntil: 'load' });
        await expect(page.locator('header.topbar h1')).toBeVisible();
        await expect(page).toHaveTitle(title);
        // CSS initially hides this warning even if a module failed. Removal
        // is the signal every tool emits only after its entry module ran.
        await expect(page.locator('#boot-warning')).toHaveCount(0, { timeout: 30_000 });
        expect((await page.locator('#main').innerText()).length).toBeGreaterThanOrEqual(main.length / 2);
        const modules = await page.evaluate(() => performance.getEntriesByType('resource')
          .filter((entry) => /\/src\/.*\.js(?:\?|$)/.test(entry.name))
          .map((entry) => ({ name: entry.name, size: (entry as PerformanceResourceTiming).decodedBodySize })));
        expect(modules.length, 'no tool modules were requested after the offline reload').toBeGreaterThan(0);
        expect(errors, errors.join('\n')).toEqual([]);
        // The encoder supplies a small independent proof of offline work;
        // the per-tool cases above prove all shipped module graphs boot.
        if (slug === 'base64') {
          await page.locator('#input').fill('offline café');
          await expect(page.locator('#output')).toHaveText(Buffer.from('offline café').toString('base64'));
        }
      } finally {
        await context.setOffline(false);
      }
    });
  }
});

test('offline: an unchanged worker refreshes HTML and preserves neighboring scope caches',
  async ({ page, request }) => {
    test.setTimeout(150_000);
    const hub = '/es/';
    const tool = localeUrl('es', 'base64');
    const scripts = new Map<string, string>();
    for (const scope of [hub, tool]) {
      const response = await request.get(`${scope}sw.js`);
      expect(response.ok(), `${scope}sw.js is missing`).toBe(true);
      scripts.set(`${scope}sw.js`, await response.text());
    }

    let revision = 1;
    // The workers are the preview's exact generated bytes. Only their origin
    // and the responses they cache belong to this test. No deployed files or
    // registrations are changed, and browser routing cannot intercept a
    // worker's network fetch reliably enough to simulate this regression.
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      const worker = scripts.get(url.pathname);
      if (worker !== undefined) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(worker);
      } else if (url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
        const scope = url.pathname.startsWith(tool) ? tool : hub;
        const version = /CACHE_VERSION\s*=\s*'([0-9a-f]{10})'/.exec(scripts.get(`${scope}sw.js`)!)![1];
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html data-offline-version="${version}" lang="en"><title>Cache fixture</title><main>revision ${revision}</main>`
          + `<script>navigator.serviceWorker.register('${scope}sw.js?v=${version}', {scope:'${scope}',updateViaCache:'none'}).catch(() => {});</script></html>`);
      } else {
        res.setHeader('Content-Type', 'text/plain');
        res.end(`network revision ${revision}`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // Install the nested tool first: activating the parent must leave it.
      await page.goto(origin + tool);
      test.skip(!await page.evaluate(() => 'serviceWorker' in navigator),
        'this engine exposes no service-worker API; the cache scenarios cannot run');
      await controlled(page, tool);
      await page.goto(origin + hub);
      await controlled(page, hub);
      const names = await page.evaluate(() => caches.keys());
      const hubName = names.find((name) => name.startsWith(`abox:${hub}:`));
      const toolName = names.find((name) => name.startsWith(`abox:${tool}:`));
      expect(hubName, 'the hub has no cache').toBeTruthy();
      expect(toolName, 'activating the parent deleted the tool cache').toBeTruthy();

      // A content-hashed request must not find an unrelated scope's old copy.
      const probe = `${origin}${tool}probe.txt?v=0123456789`;
      await page.evaluate(async ({ name, url }) => {
        const cache = await caches.open(name);
        await cache.put(url, new Response('wrong scope'));
      }, { name: hubName!, url: probe });
      await page.goto(origin + tool);
      await controlled(page, tool);
      expect(await page.evaluate((url) => fetch(url).then((response) => response.text()), probe))
        .toBe('network revision 1');

      // A guide is controlled by its hub and can change without changing any
      // byte of sw.js. This was the stale-navigation bug, not a new install.
      const guide = `${origin}${hub}guides/qa-cache/`;
      await page.goto(guide);
      await expect(page.locator('main')).toHaveText('revision 1');
      revision = 2;
      await page.reload();
      await expect(page.locator('main')).toHaveText('revision 2');
      await expect.poll(() => page.evaluate(async (url) => {
        const registration = await navigator.serviceWorker.getRegistration();
        const scope = new URL(registration!.scope).pathname;
        const name = (await caches.keys()).find((entry) => entry.startsWith(`abox:${scope}:`));
        const cached = await (await caches.open(name!)).match(url);
        if (!cached) return undefined;
        const html = new DOMParser().parseFromString(await cached.text(), 'text/html');
        return html.querySelector('main')?.textContent;
      }, guide)).toBe('revision 2');
      // Stop this origin, including persistent sockets, rather than using
      // Playwright's offline flag. This strict fallback case still runs when
      // the independent probe finds that flag blocks worker navigation.
      await stopServer(server);
      expect(server.listening, 'the controlled origin must be stopped').toBe(false);
      await page.reload();
      await expect(page.locator('main')).toHaveText('revision 2');
      await page.goto(origin + tool);
      await expect(page.locator('main')).toHaveText('revision 1');
      expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining([hubName, toolName]));
    } finally {
      await page.close();
      await stopServer(server);
    }
  });


test('offline: fresh HTML waits for its own generation despite a CDN-cached older worker',
  async ({ page, request }) => {
    test.setTimeout(150_000);
    const scope = '/base64/';
    const source = await request.get(`${scope}sw.js`);
    expect(source.ok()).toBe(true);
    const currentWorker = await source.text();
    const version = /CACHE_VERSION\s*=\s*'([0-9a-f]{10})'/.exec(currentWorker)?.[1];
    const modules = /src\/shared\/trust\.js\?v=([0-9a-f]{10})/.exec(currentWorker)?.[1];
    expect(version, 'the generated worker must identify its generation').toBeTruthy();
    expect(modules, 'the worker must list the shipped trust module').toBeTruthy();
    const oldVersion = version === '1111111111' ? '2222222222' : '1111111111';
    const oldModules = modules === '3333333333' ? '4444444444' : '3333333333';
    const oldWorker = currentWorker.replaceAll(version!, oldVersion).replaceAll(modules!, oldModules);
    const shipped = new Map<string, string>();
    for (const name of ['trust', 'phrases']) {
      const response = await request.get(`${scope}src/shared/${name}.js?v=${modules}`);
      expect(response.ok()).toBe(true);
      shipped.set(`${scope}src/shared/${name}.js`, await response.text());
    }
    let current = false;
    let held: ServerResponse | undefined;
    let requested!: () => void;
    const requestedCurrentWorker = new Promise<void>((resolve) => { requested = resolve; });
    let released = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      res.setHeader('Cache-Control', 'public, max-age=14400');
      if (url.pathname === `${scope}sw.js`) {
        res.setHeader('Content-Type', 'application/javascript');
        // The bare URL remains stale for the entire scenario. Only the URL
        // named by the current page can get the newly published worker.
        if (url.searchParams.get('v') === version) {
          if (!released) { held = res; requested(); return; }
          res.end(currentWorker);
        } else res.end(oldWorker);
      } else if (url.pathname === scope || url.pathname === `${scope}index.html`) {
        const generation = current ? version : oldVersion;
        const js = current ? modules : oldModules;
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html data-offline-version="${generation}"><title>Generation fixture</title>`
          + `<main>generation ${generation}</main><p id="boot">not booted</p>`
          + '<span id="offline-status">Checking</span><span id="offline-dot"></span>'
          + '<div id="frame-phrases" hidden><span data-phrase="offline.ready">Ready offline</span>'
          + '<span data-phrase="offline.failed">Could not save offline</span></div>'
          + `<script type="module" src="src/main.js?v=${js}"></script>`
          + (current ? `<script type="module" src="src/shared/trust.js?v=${js}"></script>`
            : `<script>navigator.serviceWorker.register('${scope}sw.js');</script>`)
          + '</html>');
      } else if (url.pathname === `${scope}src/main.js`) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(`document.getElementById('boot').textContent = 'boot ${url.searchParams.get('v')}';`);
      } else if (shipped.has(url.pathname)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(shipped.get(url.pathname));
      } else {
        res.setHeader('Content-Type', 'text/plain');
        res.end('fixture asset');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await page.goto(origin + scope);
      test.skip(!await page.evaluate(() => 'serviceWorker' in navigator),
        'this engine exposes no service-worker API');
      await controlled(page, scope);
      await expect(page.locator('#boot')).toHaveText(`boot ${oldModules}`);
      current = true;
      await page.reload();
      await requestedCurrentWorker;
      await expect(page.locator('main')).toHaveText(`generation ${version}`);
      await expect(page.locator('#boot')).toHaveText(`boot ${modules}`);
      await expect(page.locator('#offline-status')).not.toHaveClass('good');
      expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
        .toBe(`${origin}${scope}sw.js`);
      // A newer response is usable online; it must not overwrite the old
      // worker's saved HTML while that worker still owns only its old graph.
      const previous = await page.evaluate(async ({ name, scope }) => {
        const saved = await (await caches.open(name)).match(scope);
        return new DOMParser().parseFromString(await saved!.text(), 'text/html')
          .documentElement.dataset.offlineVersion;
      }, { name: `abox:${scope}:${oldVersion}`, scope });
      expect(previous).toBe(oldVersion);
      released = true;
      held!.end(currentWorker);
      await expect(page.locator('#offline-status')).toHaveClass('good', { timeout: 90_000 });
      expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL))
        .toBe(`${origin}${scope}sw.js?v=${version}`);
      const cached = await page.evaluate(async ({ name, scope, modules }) => {
        const cache = await caches.open(name);
        const page = await cache.match(scope);
        const main = await cache.match(`${scope}src/main.js?v=${modules}`);
        return { page: await page!.text(), main: await main!.text() };
      }, { name: `abox:${scope}:${version}`, scope, modules });
      expect(cached.page).toContain(`data-offline-version="${version}"`);
      expect(cached.main).toContain(`boot ${modules}`);
      await stopServer(server);
      expect(server.listening).toBe(false);
      await page.reload();
      await expect(page.locator('main')).toHaveText(`generation ${version}`);
      await expect(page.locator('#boot')).toHaveText(`boot ${modules}`);
      await expect(page.locator('#offline-status')).toHaveClass('good', { timeout: 90_000 });
    } finally {
      held?.destroy();
      await page.close();
      await stopServer(server);
    }
  });
