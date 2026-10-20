import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { ETOOLBOX_DIR } from './site';

// The source revision, rather than a missing deployed element, selects the
// contract so a regression cannot silently become a compatibility fallback.
export const unifiedPairingJoin = fs.existsSync(path.join(ETOOLBOX_DIR, 'shared/js/peer-approval-ui.js'));
export const voiceApproval = (tool: 'walkie-talkie' | 'voice-oncall') => {
  const body = path.join(ETOOLBOX_DIR, 'tools', tool, 'body.html');
  return fs.existsSync(body) && fs.readFileSync(body, 'utf8').includes(tool === 'walkie-talkie'
    ? 'id="wt-require-approval"' : 'id="vi-require-approval"');
};

export async function setVoiceApproval(page: Page, tool: 'walkie-talkie' | 'voice-oncall', required: boolean) {
  if (!voiceApproval(tool)) return;
  await page.locator(tool === 'walkie-talkie' ? '#wt-require-approval' : '#vi-require-approval').setChecked(required);
}

export async function reviewPairingRequestLater(host: Page) {
  if (!unifiedPairingJoin) return;
  const dialog = host.locator('#pairing-request-dialog');
  if (await dialog.isVisible()) {
    await dialog.locator('[data-approval-later]').click();
    await expect(dialog).toBeHidden();
  }
}

export function listedConnection(page: Page, codeOrName: string) {
  return unifiedPairingJoin
    ? page.locator('#discovery-list .paired-nearby-row').filter({ hasText: codeOrName }).getByRole('button')
    : page.locator('#discovery-list button').filter({ hasText: codeOrName });
}
