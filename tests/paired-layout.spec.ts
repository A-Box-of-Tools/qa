import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from '../lib/site';
import { withoutThirdParties } from '../lib/engine';

const tools = ['share-text', 'share-tab', 'walkie-talkie', 'voice-oncall', 'remote-camera'];

for (const tool of tools) test(`${tool}: nearby discovery comes before setup with readable Wi-Fi and hotspot guidance`, async ({ page }) => {
  const body = path.join(ETOOLBOX_DIR, 'tools', tool, 'body.html');
  test.skip(!fs.existsSync(body) || !fs.readFileSync(body, 'utf8').includes('data-pairing-nearby'),
    'The consistent pairing layout is awaiting the website release.');
  await withoutThirdParties(page);
  // An empty directory keeps layout checks independent of who shares the CI
  // runner's public address. Native pairing is covered by the tool journeys.
  await page.addInitScript(() => {
    class EmptyDirectory extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      constructor(public url: string) {
        super();
        if (new URL(url).pathname !== '/discover') throw new Error('An idle layout must not open a pairing room.');
        queueMicrotask(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1; this.emit(new Event('open'));
          const tool = new URL(url).searchParams.get('tool');
          this.emit(new MessageEvent('message', { data: JSON.stringify({ type: 'shares',
            ...(tool && tool !== 'share-text' ? { tool } : {}), list: [] }) }));
        });
      }
      emit(event: Event) { this.dispatchEvent(event); (this as any)[`on${event.type}`]?.(event); }
      send(data: string) { if (data === 'ping') this.emit(new MessageEvent('message', { data: 'pong' })); }
      close() { this.readyState = 3; this.emit(new CloseEvent('close', { code: 1000 })); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: EmptyDirectory });
  });
  await page.goto(`/${tool}/`);
  await expect(page.locator('main.paired-page')).toBeVisible();
  const nearby = page.locator('[data-pairing-nearby]');
  const setup = page.locator('[data-pairing-setup]').first();
  await expect(nearby).toBeVisible(); await expect(setup).toBeVisible();
  expect(await nearby.evaluate((element) => {
    const setup = document.querySelector('[data-pairing-setup]')!;
    return Boolean(element.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING)
      && element.getBoundingClientRect().bottom <= setup.getBoundingClientRect().top + 1;
  }), 'Nearby choices precede setup in both reading order and the rendered layout.').toBe(true);
  const help = page.locator('[data-pairing-network-help]');
  await expect(help).toHaveCount(1);
  const summary = help.locator('summary');
  if (await summary.count()) await summary.click();
  await expect(help).toContainText(/Wi-Fi/i);
  await expect(help).toContainText(/hotspot/i);
  await expect(help).toContainText(/internet/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    'The discovery area and expanded network guidance fit the desktop or phone viewport.').toBe(true);
});
