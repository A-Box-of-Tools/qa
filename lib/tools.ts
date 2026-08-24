import fs from 'node:fs';
import path from 'node:path';
import { ETOOLBOX_DIR } from './site';

/**
 * Every tool the site ships, discovered the same way build.py finds them:
 * one folder under tools/ per tool, holding a tool.toml. Reading the
 * filesystem instead of hand-listing slugs here means this suite can't fall
 * behind what the site actually built - the same reason etoolbox's own
 * README gives for generating its tool index instead of writing it by hand.
 *
 * Returns slugs only (e.g. "resize-image"), sorted, which double as the
 * tool's URL path segment.
 */
export function discoverTools(): string[] {
  const toolsDir = path.join(ETOOLBOX_DIR, 'tools');
  return fs
    .readdirSync(toolsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => fs.existsSync(path.join(toolsDir, slug, 'tool.toml')))
    .sort();
}

/**
 * Whether this tool's page includes the shared drop-zone widget
 * (templates/partials/file-picker.html). Most tools take a file; a couple -
 * password-generator, qr-barcode - generate one instead and never include
 * it, so tests that assume every tool page has a drop zone check this first.
 */
export function hasFilePicker(slug: string): boolean {
  const bodyPath = path.join(ETOOLBOX_DIR, 'tools', slug, 'body.html');
  return fs.readFileSync(bodyPath, 'utf8').includes('partials/file-picker.html');
}
