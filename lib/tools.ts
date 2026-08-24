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
