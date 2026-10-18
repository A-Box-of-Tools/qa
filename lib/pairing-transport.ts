import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { ETOOLBOX_DIR } from './site';

export type TransportMode = 'direct' | 'relay';
export type PairingAction = 'host' | 'join' | 'nearby';
const partial = path.join(ETOOLBOX_DIR, 'templates', 'partials', 'paired-transport.html');
// The checked-out source declares the contract. A missing new control on its
// deployed page must fail, rather than silently falling back to an old select.
export const compactTransport = fs.existsSync(partial)
  && fs.readFileSync(partial, 'utf8').includes('data-transport-toggle');

export function transportControl(page: Page, action: PairingAction) {
  return compactTransport
    ? page.locator(`[data-pairing-actions="${action}"] [data-transport-toggle]:visible`)
    : page.locator('#pairing-transport');
}

export function transportNote(page: Page, action: PairingAction) {
  return compactTransport
    ? page.locator(`[data-pairing-actions="${action}"] [data-transport-note]`)
    : page.locator('#pairing-transport-note');
}

export async function revealTransportNote(page: Page, action: PairingAction) {
  const note = transportNote(page, action);
  if (compactTransport && !await note.isVisible()) {
    await page.locator(`[data-pairing-actions="${action}"] details:has([data-transport-note]) summary`).click();
  }
  await expect(note).toBeVisible();
  return note;
}

export async function expectTransportMode(page: Page, mode: TransportMode, action?: PairingAction) {
  if (!compactTransport) {
    await expect(page.locator('#pairing-transport')).toHaveValue(mode);
    return;
  }
  const controls = page.locator('[data-transport-toggle]');
  expect(await controls.count(), 'The compact transport controls must be rendered.').toBeGreaterThan(0);
  for (const control of await controls.all()) {
    await expect(control).toHaveAttribute('type', 'checkbox');
    await expect(control).toHaveAttribute('role', 'switch');
    if (await control.isVisible()) {
      await expect(control).toHaveRole('switch');
      await expect(control).toHaveAccessibleName('Cloud relay');
    }
    if (mode === 'relay') await expect(control).toBeChecked();
    else await expect(control).not.toBeChecked();
  }
  if (action) {
    await expect(transportControl(page, action)).toHaveCount(1);
    await expect(transportControl(page, action)).toBeVisible();
  }
}

export async function chooseTransport(page: Page, mode: TransportMode, action: PairingAction) {
  const control = transportControl(page, action);
  if (compactTransport) await control.setChecked(mode === 'relay');
  else await control.selectOption(mode);
  await expectTransportMode(page, mode, action);
}

export async function expectTransportLocked(page: Page, locked = true) {
  const controls = page.locator(compactTransport ? '[data-transport-toggle]' : '#pairing-transport');
  expect(await controls.count()).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    if (locked) await expect(control).toBeDisabled();
    else await expect(control).toBeEnabled();
  }
}

export async function expectTransportNearAction(page: Page, action: PairingAction, buttonSelector: string) {
  if (!compactTransport) return;
  const row = page.locator(`[data-pairing-actions="${action}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.locator(buttonSelector)).toBeVisible();
  await expect(transportControl(page, action)).toBeVisible();
  const layout = await row.evaluate((element, selector) => {
    const button = element.querySelector(selector)!.getBoundingClientRect();
    const toggle = element.querySelector('[data-pairing-transport]')!.getBoundingClientRect();
    const horizontalOverlap = Math.min(button.right, toggle.right) > Math.max(button.left, toggle.left);
    const verticalOverlap = Math.min(button.bottom, toggle.bottom) > Math.max(button.top, toggle.top);
    return {
      adjacent: (verticalOverlap && toggle.left >= button.right - 1 && toggle.left - button.right <= 32)
        || (horizontalOverlap && toggle.top >= button.bottom - 1 && toggle.top - button.bottom <= 32),
      fits: Math.min(button.left, toggle.left) >= -1
        && Math.max(button.right, toggle.right) <= document.documentElement.clientWidth + 1,
    };
  }, buttonSelector);
  expect(layout.adjacent, 'The transport toggle stays beside its action, or immediately below it when the row wraps.').toBe(true);
  expect(layout.fits, 'The action and transport toggle fit the desktop or phone viewport.').toBe(true);
}

