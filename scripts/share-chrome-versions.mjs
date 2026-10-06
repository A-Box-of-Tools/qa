/**
 * Freeze the actual Chrome binaries used by mixed-version Local network QA.
 * Availability metadata selects versions once; installation never substitutes
 * another browser when that frozen choice is missing or malformed.
 *
 * node scripts/share-chrome-versions.mjs resolve --output chrome-versions.json
 * node scripts/share-chrome-versions.mjs install --manifest chrome-versions.json --cache-dir .chrome
 * node scripts/share-chrome-versions.mjs validate --manifest chrome-versions.json
 * node scripts/share-chrome-versions.mjs describe --manifest chrome-versions.json --cache-dir .chrome
 */
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const execFileAsync = promisify(execFile);
const METADATA_ROOT = 'https://googlechromelabs.github.io/chrome-for-testing/';
const DOWNLOAD_ROOT = 'https://storage.googleapis.com/chrome-for-testing-public/';
const HISTORICAL = { older: '153.0.8010.53', newer: '154.0.8037.98' };
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

function assert(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), `${label} has missing or unexpected fields`);
}
function versionParts(version) {
  assert(typeof version === 'string' && /^(?:0|[1-9]\d{0,5})(?:\.(?:0|[1-9]\d{0,5})){3}$/.test(version), 'Invalid full Chrome version');
  const parts = version.split('.').map(Number);
  assert(parts[0] > 0, 'Invalid Chrome milestone');
  return parts;
}
function officialUrl(version) {
  versionParts(version);
  return `${DOWNLOAD_ROOT}${version}/win64/chrome-win64.zip`;
}
function validateBrowser(browser, label) {
  exactKeys(browser, ['version', 'url'], label);
  assert(browser.url === officialUrl(browser.version), `${label} URL must be the exact official win64 Chrome asset for its version`);
}
export function validateManifest(manifest) {
  exactKeys(manifest, ['schemaVersion', 'platform', 'pairs'], 'Manifest');
  assert(manifest.schemaVersion === 1 && manifest.platform === 'win64', 'Manifest must use schemaVersion 1 and platform win64');
  assert(Array.isArray(manifest.pairs) && manifest.pairs.length === 2, 'Manifest must contain historical and rolling pairs');
  const seen = new Set();
  for (const pair of manifest.pairs) {
    exactKeys(pair, ['id', 'older', 'newer'], 'Pair');
    assert(['historical', 'rolling'].includes(pair.id) && !seen.has(pair.id), 'Invalid or duplicate pair id');
    seen.add(pair.id);
    validateBrowser(pair.older, `${pair.id}.older`);
    validateBrowser(pair.newer, `${pair.id}.newer`);
    assert(versionParts(pair.older.version)[0] + 1 === versionParts(pair.newer.version)[0], 'Pairs must use adjacent Chrome milestones');
    if (pair.id === 'historical') {
      assert(pair.older.version === HISTORICAL.older && pair.newer.version === HISTORICAL.newer, 'Historical pair must retain the exact investigated versions');
    }
  }
  return manifest;
}
function checkedChild(root, ...parts) {
  const absoluteRoot = path.resolve(root);
  const result = path.resolve(absoluteRoot, ...parts);
  const relative = path.relative(absoluteRoot, result);
  assert(relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Cache path escaped its root');
  return result;
}
function executablePath(cacheDir, version) {
  versionParts(version);
  return checkedChild(cacheDir, version, 'chrome-win64', 'chrome.exe');
}
export function describeManifest(manifest, cacheDir) {
  validateManifest(manifest);
  return {
    schemaVersion: 1, platform: 'win64',
    pairs: manifest.pairs.map((pair) => ({
      id: pair.id,
      older: { ...pair.older, executable: executablePath(cacheDir, pair.older.version) },
      newer: { ...pair.newer, executable: executablePath(cacheDir, pair.newer.version) },
    })),
  };
}
async function responseFor(url, limit, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { signal, redirect: 'error' });
  assert(response.status === 200 && response.body, `Official asset request failed with HTTP ${response.status}: ${url}`);
  const length = response.headers.get('content-length');
  if (length !== null) assert(/^\d+$/.test(length) && BigInt(length) <= BigInt(limit), `Official response exceeds ${limit} bytes`);
  return { response, signal };
}
async function metadata(name) {
  const { response } = await responseFor(`${METADATA_ROOT}${name}`, MAX_JSON_BYTES, 30000);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      assert(total <= MAX_JSON_BYTES, 'Official metadata exceeds its size limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
function metadataBrowser(entry, expectedMajor) {
  assert(entry && typeof entry === 'object', 'Official version metadata is missing');
  const parts = versionParts(entry.version);
  if (expectedMajor !== undefined) assert(parts[0] === expectedMajor, 'Official milestone metadata does not match the requested major');
  const matches = entry.downloads?.chrome?.filter((asset) => asset.platform === 'win64');
  assert(Array.isArray(matches) && matches.length === 1, 'Official metadata must contain one win64 Chrome download');
  const browser = { version: entry.version, url: matches[0].url };
  validateBrowser(browser, 'Official browser');
  return browser;
}
export async function resolveManifest() {
  const [channels, milestones] = await Promise.all([
    metadata('last-known-good-versions-with-downloads.json'),
    metadata('latest-versions-per-milestone-with-downloads.json'),
  ]);
  const stable = channels.channels?.Stable;
  assert(stable?.channel === 'Stable', 'Official Stable channel metadata is missing');
  const newer = metadataBrowser(stable);
  const priorMajor = versionParts(newer.version)[0] - 1;
  const previous = milestones.milestones?.[String(priorMajor)];
  assert(previous?.milestone === String(priorMajor), 'Official previous milestone metadata is missing');
  const older = metadataBrowser(previous, priorMajor);
  return validateManifest({
    schemaVersion: 1, platform: 'win64',
    pairs: [
      { id: 'historical', older: { version: HISTORICAL.older, url: officialUrl(HISTORICAL.older) }, newer: { version: HISTORICAL.newer, url: officialUrl(HISTORICAL.newer) } },
      { id: 'rolling', older, newer },
    ],
  });
}
async function readManifest(filename) {
  const info = await fs.stat(filename);
  assert(info.isFile() && info.size <= MAX_JSON_BYTES, 'Manifest must be a bounded JSON file');
  return validateManifest(JSON.parse(await fs.readFile(filename, 'utf8')));
}
async function writeManifest(filename, manifest) {
  const destination = path.resolve(filename);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function download(browser, filename) {
  validateBrowser(browser, 'Download');
  const { response, signal } = await responseFor(browser.url, MAX_ARCHIVE_BYTES, 180000);
  let total = 0;
  const bound = new Transform({ transform(chunk, encoding, callback) {
    total += chunk.length;
    callback(total > MAX_ARCHIVE_BYTES ? new Error('Chrome archive exceeds its size limit') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(filename, { flags: 'wx' }), { signal });
  assert(total > 0, 'Official Chrome archive is empty');
}

// Paths enter PowerShell through environment variables, never through shell text.
// Reject aliases, traversal, special files and excessive expansion before any
// archive member is extracted into the temporary cache directory.
const EXPAND_ARCHIVE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskRoot = [System.IO.Path]::GetFullPath($env:SHARE_CHROME_STAGE)
$taskPrefix = $taskRoot.TrimEnd([char]92, [char]47) + [System.IO.Path]::DirectorySeparatorChar
$taskNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$taskZip = [System.IO.Compression.ZipFile]::OpenRead($env:SHARE_CHROME_ARCHIVE)
$taskExpanded = [long]0
$taskHasChrome = $false
try {
  if ($taskZip.Entries.Count -gt 10000) { throw 'Too many Chrome archive entries' }
  foreach ($taskEntry in $taskZip.Entries) {
    $taskName = $taskEntry.FullName.Replace([char]92, [char]47)
    if (-not $taskName.StartsWith('chrome-win64/', [System.StringComparison]::Ordinal)) { throw 'Unexpected Chrome archive root' }
    $taskNormalized = $taskName.TrimEnd([char]47)
    if (-not $taskNames.Add($taskNormalized)) { throw 'Duplicate Chrome archive path' }
    foreach ($taskSegment in $taskNormalized.Split([char]47)) {
      if ($taskSegment -eq '' -or $taskSegment -eq '.' -or $taskSegment -eq '..' -or
          $taskSegment -match '[\x00-\x1f:*?"<>|]' -or $taskSegment.EndsWith('.') -or $taskSegment.EndsWith(' ') -or
          $taskSegment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe Chrome archive path' }
    }
    $taskUnixKind = ($taskEntry.ExternalAttributes -shr 16) -band 61440
    if (($taskUnixKind -ne 0 -and $taskUnixKind -ne 32768 -and $taskUnixKind -ne 16384) -or
        ($taskEntry.ExternalAttributes -band 1024) -ne 0) { throw 'Special Chrome archive entry' }
    $taskTarget = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($taskRoot, $taskName))
    if (-not $taskTarget.StartsWith($taskPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Chrome archive escaped its staging directory' }
    $taskExpanded += $taskEntry.Length
    if ($taskEntry.Length -gt 1073741824 -or $taskExpanded -gt 2147483648) { throw 'Chrome archive exceeds expansion limit' }
    if ($taskName -ceq 'chrome-win64/chrome.exe' -and $taskEntry.Length -gt 0) { $taskHasChrome = $true }
  }
  if (-not $taskHasChrome) { throw 'Chrome executable is missing from archive' }
} finally { $taskZip.Dispose() }
Expand-Archive -LiteralPath $env:SHARE_CHROME_ARCHIVE -DestinationPath $taskRoot -ErrorAction Stop
`;
const VERIFY_VERSION = String.raw`
$ErrorActionPreference = 'Stop'
$taskVersion = (Get-Item -LiteralPath $env:SHARE_CHROME_EXECUTABLE -ErrorAction Stop).VersionInfo.ProductVersion
if ($taskVersion -cne $env:SHARE_CHROME_VERSION) { throw ('Chrome executable version mismatch: ' + $taskVersion) }
`;
async function powershell(script, env) {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env }, windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024,
  });
}
async function plainDirectory(filename) {
  const info = await fs.lstat(filename);
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Chrome cache contains an unexpected directory alias');
}
async function verifyExecutable(cacheRoot, version) {
  await plainDirectory(checkedChild(cacheRoot, version));
  await plainDirectory(checkedChild(cacheRoot, version, 'chrome-win64'));
  const executable = executablePath(cacheRoot, version);
  const info = await fs.lstat(executable);
  assert(info.isFile() && !info.isSymbolicLink(), 'Chrome executable must be a regular cached file');
  await powershell(VERIFY_VERSION, { SHARE_CHROME_EXECUTABLE: executable, SHARE_CHROME_VERSION: version });
  return executable;
}
async function exists(filename) {
  try { await fs.lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function installManifest(manifest, cacheDir) {
  validateManifest(manifest);
  assert(process.platform === 'win32', 'win64 Chrome provisioning must run on Windows');
  await fs.mkdir(path.resolve(cacheDir), { recursive: true });
  const cacheRoot = await fs.realpath(path.resolve(cacheDir));
  const browsers = new Map(manifest.pairs.flatMap((pair) => [pair.older, pair.newer]).map((browser) => [browser.version, browser]));
  for (const browser of browsers.values()) {
    const destination = checkedChild(cacheRoot, browser.version);
    if (await exists(destination)) {
      await verifyExecutable(cacheRoot, browser.version);
      continue;
    }
    const staging = checkedChild(cacheRoot, `.install-${browser.version}-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      const archive = checkedChild(staging, 'chrome.zip');
      const unpacked = checkedChild(staging, 'unpacked');
      await download(browser, archive);
      await powershell(EXPAND_ARCHIVE, { SHARE_CHROME_ARCHIVE: archive, SHARE_CHROME_STAGE: unpacked });
      await powershell(VERIFY_VERSION, { SHARE_CHROME_EXECUTABLE: checkedChild(unpacked, 'chrome-win64', 'chrome.exe'), SHARE_CHROME_VERSION: browser.version });
      // Both move targets are resolved descendants of the explicitly named cache.
      checkedChild(cacheRoot, path.relative(cacheRoot, unpacked));
      checkedChild(cacheRoot, path.relative(cacheRoot, destination));
      await fs.rename(unpacked, destination);
      await verifyExecutable(cacheRoot, browser.version);
    } finally {
      // Never recursively remove a version directory or a computed path outside
      // the cache; only this invocation's checked temporary child is disposable.
      checkedChild(cacheRoot, path.relative(cacheRoot, staging));
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return describeManifest(manifest, cacheRoot);
}
function options(command, args) {
  const keys = { resolve: ['output'], install: ['manifest', 'cache-dir'], validate: ['manifest'], describe: ['manifest', 'cache-dir'] }[command];
  assert(keys, 'Use resolve, install, validate, or describe');
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    assert(args[i]?.startsWith('--') && keys.includes(key) && !Object.hasOwn(result, key) && typeof args[i + 1] === 'string' && args[i + 1] !== '' && !args[i + 1].startsWith('--'), 'Invalid, duplicate, or incomplete command option');
    result[key] = args[i + 1];
  }
  assert(keys.every((key) => Object.hasOwn(result, key)), `Required options: ${keys.map((key) => `--${key} PATH`).join(' ')}`);
  return result;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flags = options(command, args);
  if (command === 'resolve') {
    const manifest = await resolveManifest();
    await writeManifest(flags.output, manifest);
    console.log(`Frozen Chrome versions written to ${path.resolve(flags.output)}`);
  } else {
    const manifest = await readManifest(flags.manifest);
    if (command === 'install') console.log(JSON.stringify(await installManifest(manifest, flags['cache-dir']), null, 2));
    else if (command === 'describe') console.log(JSON.stringify(describeManifest(manifest, flags['cache-dir']), null, 2));
    else console.log('Chrome version manifest is valid');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Chrome provisioning failed: ${error.message}`); process.exitCode = 1; });
}
