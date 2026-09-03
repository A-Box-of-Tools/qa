import { test, expect, type Page } from '@playwright/test';
import { quiet } from '../lib/engine';

/**
 * The measurement tag, from both sides.
 *
 * This suite opens every page on the site several times a day. Before the
 * guard in templates/analytics.js, every one of those loads arrived in
 * Google Analytics as a session: a bounce rate, a country, an audience of
 * robots averaged in with the people the numbers are actually kept for.
 *
 * So there are two tests here and neither is worth much without the other.
 *
 * The first says this suite sends nothing. On its own that is a claim no
 * failing configuration could contradict - a tag that had stopped working
 * entirely would pass it, and pass it silently, which is exactly how the
 * Cloudflare beacon on this site sat dead behind its own CSP until something
 * went looking.
 *
 * The second is that something going looking. It presents itself as an
 * ordinary browser and requires that a measurement hit be attempted - which
 * proves the tag still functions, and proves the first test is measuring the
 * guard rather than measuring a corpse.
 *
 * The hit is intercepted rather than sent. A test that verifies the site
 * ignores robots should not spend its own runs putting robot traffic into
 * the numbers, and the attempt is all the evidence the assertion needs.
 */

const MEASUREMENT = /google-analytics\.com|analytics\.google\.com|\/g\/collect/;

/** The tag's id, read from the site's own config rather than repeated here. */
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, ETOOLBOX_DIR } from '../lib/site';

const analyticsId = (): string => {
  const toml = fs.readFileSync(path.join(ETOOLBOX_DIR, 'config', 'site.toml'), 'utf8');
  const id = toml.match(/^analytics_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!id) throw new Error('config/site.toml has no analytics_id');
  return id;
};

/**
 * Is the suite pointed at the site's own domain? templates/analytics.js
 * switches measurement off anywhere else - a pull request's preview, a local
 * build - so what can be asserted about the tag depends on the answer.
 */
const onProductionDomain = (): boolean => {
  const toml = fs.readFileSync(path.join(ETOOLBOX_DIR, 'config', 'site.toml'), 'utf8');
  const domain = toml.match(/^domain\s*=\s*"([^"]+)"/m)?.[1];
  if (!domain) throw new Error('config/site.toml has no domain');
  return new URL(BASE_URL).origin === new URL(domain).origin;
};

/**
 * Watch for measurement hits without letting any of them leave.
 *
 * The request event fires before the route is answered, so the attempt is
 * still observable; nothing reaches Google either way.
 */
async function countHits(page: Page): Promise<string[]> {
  const hits: string[] = [];
  // Fulfilled with an empty 204 rather than aborted. An aborted hit looks
  // like a network failure, and the tag retries it - which keeps the page
  // permanently busy and means networkidle never arrives. A 204 is a clean
  // success to the browser and still reaches nobody.
  await page.route(MEASUREMENT, (route) => route.fulfill({ status: 204, body: '' }));
  page.on('request', (req) => {
    if (MEASUREMENT.test(req.url())) hits.push(req.url());
  });
  return hits;
}

test.describe('analytics', () => {
  test('this suite is not counted as visitors', async ({ page }) => {
    const hits = await countHits(page);

    await page.goto('/dicom-viewer/');
    await quiet(page);

    const state = await page.evaluate((id) => ({
      webdriver: navigator.webdriver,
      disabled: (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
      gtag: typeof (window as unknown as Record<string, unknown>).gtag,
    }), analyticsId());

    // The premise. If a future Playwright stopped setting this, the guard
    // would stop firing and this file should say so loudly rather than
    // quietly passing.
    expect(state.webdriver, 'the browser no longer reports itself as automated').toBe(true);
    expect(state.disabled, "the site's opt-out switch was not set for an automated browser")
      .toBe(true);

    // gtag has to stay defined even when switched off: shared/feedback.js
    // calls it, and an undefined global there is a crash rather than a
    // no-op.
    expect(state.gtag, 'gtag must remain callable when measurement is off').toBe('function');

    expect(hits, `this run sent ${hits.length} measurement hit(s)`).toEqual([]);
  });

  test('control: an ordinary browser is still measured', async ({ page }) => {
    // Away from the production domain - a pull request's preview, a local
    // build - the tag switches itself off for everyone, by design
    // (templates/analytics.js), so there is nothing here to control against.
    test.skip(!onProductionDomain(),
      'measurement is switched off away from the site\'s own domain, so the control has nothing to measure');

    // Without this, the test above would pass just as happily against a tag
    // that had stopped working altogether.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    });
    const hits = await countHits(page);

    await page.goto('/dicom-viewer/');
    await expect.poll(() => hits.length, { timeout: 20_000 }).toBeGreaterThan(0);

    const disabled = await page.evaluate(
      (id) => (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
      analyticsId(),
    );
    expect(disabled, 'the guard fired for a browser that does not claim automation').toBeUndefined();

    expect(
      hits.length,
      'a browser presenting as an ordinary visitor produced no measurement hit at all - '
      + 'the tag is not working, and the test above is measuring nothing',
    ).toBeGreaterThan(0);
  });
});
