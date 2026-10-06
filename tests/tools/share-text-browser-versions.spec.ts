import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Browser } from '@playwright/test';
import { runLocalShareJourney } from '../../lib/share-text-local-network';

interface ChromeBuild { version: string; url: string }
interface VersionPair { id: 'historical' | 'rolling'; older: ChromeBuild; newer: ChromeBuild }
interface VersionManifest { schemaVersion: 1; platform: 'win64'; pairs: VersionPair[] }

// Stable changes while a run waits in the queue. Reading the frozen manifest
// here keeps all four journeys and any failure-only rerun on the same builds.
const manifestPath = process.env.SHARE_CROSS_VERSION_MANIFEST;
const cacheDirectory = process.env.SHARE_CROSS_VERSION_CACHE_DIR;
if (!manifestPath || !cacheDirectory) {
  throw new Error('Chrome compatibility requires a frozen manifest and binary cache directory');
}
const manifest: VersionManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.platform !== 'win64'
    || !Array.isArray(manifest.pairs) || manifest.pairs.length !== 2
    || manifest.pairs.map(pair => pair.id).sort().join(',') !== 'historical,rolling') {
  throw new Error('Invalid Chrome compatibility manifest');
}
for (const pair of manifest.pairs) {
  for (const build of [pair.older, pair.newer]) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(build.version)
        || build.url !== `https://storage.googleapis.com/chrome-for-testing-public/${build.version}/win64/chrome-win64.zip`) {
      throw new Error('Chrome compatibility requires exact official win64 builds');
    }
  }
  const oldMajor = Number(pair.older.version.split('.')[0]);
  const newMajor = Number(pair.newer.version.split('.')[0]);
  if (oldMajor + 1 !== newMajor
      || (pair.id === 'historical' && (pair.older.version !== '153.0.8010.53'
        || pair.newer.version !== '154.0.8037.98'))) {
    throw new Error('Chrome compatibility manifest contains the wrong version pair');
  }
}

test.describe('share-text: Windows Chrome version compatibility', () => {
  test.describe.configure({ mode: 'default' });
  for (const pair of manifest.pairs) {
    for (const direction of ['older-to-newer', 'newer-to-older'] as const) {
      // Titles stay stable so --last-failed can select the original case.
      // Exact full versions are attached and checked against live processes.
      test(`${pair.id} ${direction} delivers approved local content`, async ({ playwright }, testInfo) => {
        test.setTimeout(150_000);
        const sharer = direction === 'older-to-newer' ? pair.older : pair.newer;
        const reader = direction === 'older-to-newer' ? pair.newer : pair.older;
        const executable = (build: ChromeBuild) => path.join(cacheDirectory, build.version, 'chrome-win64', 'chrome.exe');
        await testInfo.attach('chrome-version-pair.json', {
          body: Buffer.from(JSON.stringify({ pair: pair.id, direction, sharer, reader, platform: manifest.platform }, null, 2)),
          contentType: 'application/json',
        });
        expect(process.platform, 'This compatibility slice must execute on Windows').toBe('win32');
        let sharerBrowser: Browser | undefined;
        let readerBrowser: Browser | undefined;
        try {
          expect(fs.existsSync(executable(sharer)), 'The exact sharer executable must be provisioned').toBe(true);
          expect(fs.existsSync(executable(reader)), 'The exact reader executable must be provisioned').toBe(true);
          sharerBrowser = await playwright.chromium.launch({ executablePath: executable(sharer) });
          readerBrowser = await playwright.chromium.launch({ executablePath: executable(reader) });
          await runLocalShareJourney({ sharerBrowser, readerBrowser }, testInfo, {
            expectedVersions: { sharer: sharer.version, reader: reader.version },
            requireSentMdns: true,
            scope: 'different Chrome versions in separate Windows processes on one runner',
          });
        } finally {
          await readerBrowser?.close();
          await sharerBrowser?.close();
        }
      });
    }
  }
});
