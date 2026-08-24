import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { discoverTools } from '../lib/tools';

// Every 5th tool, evenly spread across categories - enough to catch a
// systemic issue (a shared template or shared/css rule) without scanning
// all ~30 pages at both viewports on every run.
const sample = discoverTools().filter((_, i) => i % 5 === 0);

async function seriousViolations(page: import('@playwright/test').Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test.describe('accessibility (axe, serious/critical only)', () => {
  test('hub page', async ({ page }) => {
    await page.goto('/');
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  for (const slug of sample) {
    test(`tool page: ${slug}`, async ({ page }) => {
      await page.goto(`/${slug}/`);
      const violations = await seriousViolations(page);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }
});
