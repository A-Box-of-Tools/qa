/** A diagnostic repeat must exercise the source it names, not a stale preview. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const directory = path.join(process.argv[2], 'remote-camera');
const base = new URL(process.env.BASE_URL);
if (base.protocol !== 'https:' || !base.hostname.endsWith('.abox-preview.pages.dev')) {
  throw new Error('Camera diagnostics require an explicit development preview.');
}
const digest = value => createHash('sha256').update(value).digest('hex');
const read = async relative => {
  const response = await fetch(new URL('/remote-camera/' + relative, base), { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Camera preview asset is unavailable: ' + relative);
  return Buffer.from(await response.arrayBuffer());
};
const main = html => {
  const matches = [...html.matchAll(/<main\b[^>]*>[\s\S]*?<\/main>/g)];
  if (matches.length !== 1) throw new Error('Camera page must have one main region.');
  return matches[0][0];
};
const expected = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
const actual = (await read('')).toString('utf8');
if (digest(main(actual)) !== digest(main(expected))) throw new Error('Camera preview differs from the pinned source.');
const version = expected.match(/data-pairing-version="([a-f0-9]{10})"/)?.[1];
if (!version || actual.match(/data-pairing-version="([a-f0-9]{10})"/)?.[1] !== version) {
  throw new Error('Camera preview runtime graph does not match the pinned source.');
}
const assets = ['styles.css'];
function visit(relative) {
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative + '/' + entry.name;
    if (entry.isDirectory()) visit(name); else assets.push(name);
  }
}
visit('src');
for (let offset = 0; offset < assets.length; offset += 4) {
  await Promise.all(assets.slice(offset, offset + 4).map(async asset => {
    if (digest(await read(asset + '?v=' + version)) !== digest(fs.readFileSync(path.join(directory, asset)))) {
      throw new Error('Camera preview asset differs from pinned source: ' + asset);
    }
  }));
}
console.log('Verified Camera rendered content, graph ' + version + ', and ' + assets.length + ' assets.');
