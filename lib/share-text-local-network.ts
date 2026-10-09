import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { BASE_URL, ETOOLBOX_DIR } from './site';

const TEXT = 'QA-local-network-text-71e62';
const FILE_MARKER = 'QA-local-network-file-b8c03';
const rendezvousSource = fs.readFileSync(path.join(ETOOLBOX_DIR, 'tools/share-text/src/main.js'), 'utf8');
const rendezvousUrl = rendezvousSource.match(/^const RENDEZVOUS = '(wss:\/\/[^']+)';/m)?.[1];
if (!rendezvousUrl) throw new Error('share-text no longer names its rendezvous');
const rendezvousHost = new URL(rendezvousUrl).host;

export type LocalShareJourneyOptions = {
  expectedVersions?: { sharer: string; reader: string };
  requireSentMdns?: boolean;
  scope?: string;
};

/** Keep counts, never the addresses or SDP carried by the real introduction. */
function signalingFor(page: Page) {
  // Aggregate counts include both directions and SDP as well as trickle ICE.
  // Sent counts prove what this browser emitted rather than what its peer sent.
  const state = { frames: 0, offers: 0, answers: 0, candidates: 0,
    mdnsCandidates: 0, sentCandidates: 0, sentMdnsCandidates: 0,
    nonHostCandidates: 0, relayRequests: 0, contentLeaks: 0 };
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).host !== rendezvousHost) return;
    const inspect = (sent: boolean) => ({ payload }: { payload: string | Buffer }) => {
      const raw = typeof payload === 'string' ? payload : payload.toString();
      state.frames++;
      if (raw.includes(TEXT) || raw.includes(FILE_MARKER)) state.contentLeaks++;
      let message: any;
      try { message = JSON.parse(raw); } catch { return; }
      if (message?.relay === true) state.relayRequests++;
      const data = message?.data;
      if (data?.sdp?.type === 'offer') state.offers++;
      if (data?.sdp?.type === 'answer') state.answers++;
      const inspectCandidate = (value: string) => {
        const fields = value.trim().replace(/^a=/, '').split(/\s+/);
        state.candidates++;
        if (sent) state.sentCandidates++;
        if (fields[7] !== 'host') state.nonHostCandidates++;
        if (/\.local$/i.test(fields[4] ?? '')) {
          state.mdnsCandidates++;
          if (sent) state.sentMdnsCandidates++;
        }
      };
      if (data?.candidate?.candidate) inspectCandidate(data.candidate.candidate);
      for (const line of (data?.sdp?.sdp ?? '').split(/\r?\n/)) {
        if (line.startsWith('a=candidate:')) inspectCandidate(line);
      }
    };
    socket.on('framesent', inspect(true));
    socket.on('framereceived', inspect(false));
  });
  return state;
}

/** Observe native connections without changing their configuration or delivery. */
async function observePeers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const peers: RTCPeerConnection[] = [];
    (window as any).__qaLocalPeers = peers;
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        peers.push(this);
      }
    };
  });
}

async function peerSummary(page: Page) {
  return page.evaluate(async () => {
    const peers: RTCPeerConnection[] = (window as any).__qaLocalPeers ?? [];
    return Promise.all(peers.map(async (peer) => {
      const pairs: Record<string, number> = {};
      const channels: Record<string, number> = {};
      let localCandidates = 0;
      let remoteCandidates = 0;
      let successfulSelectedPairs = 0;
      let selectedRelayPairs = 0;
      const report = await peer.getStats();
      const entries = new Map<string, any>();
      report.forEach((entry) => entries.set(entry.id, entry));
      report.forEach((entry) => {
        if (entry.type === 'local-candidate') localCandidates++;
        if (entry.type === 'remote-candidate') remoteCandidates++;
        if (entry.type === 'candidate-pair') pairs[entry.state] = (pairs[entry.state] ?? 0) + 1;
        if (entry.type === 'data-channel') channels[entry.state] = (channels[entry.state] ?? 0) + 1;
        if (entry.type === 'transport' && entry.selectedCandidatePairId) {
          const pair = entries.get(entry.selectedCandidatePairId);
          if (pair?.state === 'succeeded') successfulSelectedPairs++;
          const local = pair && entries.get(pair.localCandidateId);
          const remote = pair && entries.get(pair.remoteCandidateId);
          if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') selectedRelayPairs++;
        }
      });
      return { ice: peer.iceConnectionState, connection: peer.connectionState,
        signaling: peer.signalingState, iceServerCount: peer.getConfiguration().iceServers?.length ?? 0,
        localCandidates, remoteCandidates, pairs, channels, successfulSelectedPairs, selectedRelayPairs };
    }));
  });
}

/** Each caller supplies its real browser pair; the journey owns only contexts. */
export async function runLocalShareJourney(
  { sharerBrowser, readerBrowser }: { sharerBrowser: Browser; readerBrowser: Browser },
  testInfo: TestInfo,
  options: LocalShareJourneyOptions = {},
): Promise<void> {
  const browserVersions = { sharer: sharerBrowser.version(), reader: readerBrowser.version() };
  const code = `qa-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let sharerContext: BrowserContext | undefined;
  let readerContext: BrowserContext | undefined;
  let sharer: Page | undefined;
  let reader: Page | undefined;
  let connectedPeers: { sharer: Awaited<ReturnType<typeof peerSummary>>;
    reader: Awaited<ReturnType<typeof peerSummary>> } | undefined;
  let sharerSignaling: ReturnType<typeof signalingFor> | undefined;
  let readerSignaling: ReturnType<typeof signalingFor> | undefined;
  try {
    if (options.expectedVersions) {
      expect(browserVersions.sharer, 'the sharer must run the requested full browser version')
        .toBe(options.expectedVersions.sharer);
      expect(browserVersions.reader, 'the reader must run the requested full browser version')
        .toBe(options.expectedVersions.reader);
    }
    sharerContext = await sharerBrowser.newContext({ baseURL: BASE_URL });
    sharer = await sharerContext.newPage();
    sharerSignaling = signalingFor(sharer);
    await observePeers(sharer);
    await sharer.goto('/share-text/');
    await sharer.locator('#text').fill(TEXT);
    await sharer.locator('#code').fill(code);
    await sharer.locator('#local').check();
    await sharer.locator('#discoverable').check();
    await sharer.locator('#private').check();
    const file = Buffer.concat([Buffer.from(FILE_MARKER),
      Buffer.from(Array.from({ length: 131_072 }, (_, index) => index % 256))]);
    await sharer.locator('#fileinput').setInputFiles({
      name: 'qa-local-network.bin', mimeType: 'application/octet-stream', buffer: file,
    });
    await sharer.locator('#publish').click();
    await expect(sharer.locator('#link')).toHaveValue(/share-text/, { timeout: 30_000 });
    const link = await sharer.locator('#link').inputValue();
    expect(new URL(link).searchParams.getAll('local')).toEqual(['1']);
    expect(new URL(link).hash).toBe(`#${code}`);

    readerContext = await readerBrowser.newContext({ baseURL: BASE_URL });
    reader = await readerContext.newPage();
    readerSignaling = signalingFor(reader);
    await observePeers(reader);
    const readerResponse = await reader.goto('/share-text/');
    expect(readerResponse?.status(), 'the reader page must load before discovery is checked').toBe(200);
    await expect(reader.locator('#text'), 'the reader tool must load before discovery is checked').toBeVisible();
    const listedShare = reader.locator(`#discovery-list a[href$="#${code}"]`);
    await expect(listedShare, 'being listed alone must not count as a working share')
      .toBeVisible({ timeout: 30_000 });
    await expect(listedShare).toHaveAttribute('href', link);
    // Following the actual directory href keeps observers installed before
    // startup without replacing the production discovery or consent controls.
    await reader.goto((await listedShare.getAttribute('href'))!);
    await expect(reader.locator('#consent')).toBeVisible({ timeout: 20_000 });
    await expect(reader.locator('#local-note')).toBeVisible();
    expect(await peerSummary(reader), 'discovery must not connect before consent').toHaveLength(0);
    await reader.locator('#connect').click();
    await expect(reader.locator('#knockrow')).toBeVisible({ timeout: 30_000 });
    await reader.locator('#knock').fill('Local network QA');
    await reader.locator('#send-knock').click();
    await expect(sharer.locator('#requests')).toContainText('Local network QA', { timeout: 15_000 });
    await expect(reader.locator('#panel')).not.toContainText(TEXT);
    await expect(reader.locator('#filelist button')).toHaveCount(0);
    await sharer.locator('#requests button').first().click();
    await expect(reader.locator('#panel')).toContainText(TEXT, { timeout: 15_000 });
    await expect(reader.locator('#filelist .filerow')).toHaveCount(1);
    const fileRow = reader.locator('#filelist .filerow');
    const taggedDownload = fileRow.locator('[data-file-download]');
    const downloadButton = await taggedDownload.count() > 0
      ? taggedDownload : fileRow.getByRole('button', { name: 'Download', exact: true });
    await expect(downloadButton, 'one Download action must be available for the offered file').toHaveCount(1);
    // Observing both rejections immediately keeps context cleanup from masking a failed click.
    const [download] = await Promise.all([
      reader.waitForEvent('download'),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toBe('qa-local-network.bin');
    expect(fs.readFileSync((await download.path())!)).toEqual(file);

    await sharer.locator('#text').fill(`${TEXT}\nQA-local-live-edit`);
    await expect(reader.locator('#panel')).toContainText('QA-local-live-edit', { timeout: 15_000 });
    connectedPeers = { sharer: await peerSummary(sharer), reader: await peerSummary(reader) };
    for (const peers of [connectedPeers.sharer, connectedPeers.reader]) {
      expect(peers).toHaveLength(1);
      expect(peers[0].iceServerCount).toBe(0);
      expect(peers[0].successfulSelectedPairs).toBeGreaterThan(0);
      expect(peers[0].selectedRelayPairs).toBe(0);
      expect(peers[0].channels.open).toBeGreaterThan(0);
    }
    for (const state of [sharerSignaling, readerSignaling]) {
      expect(state.frames).toBeGreaterThan(0);
      expect(state.offers).toBeGreaterThan(0);
      expect(state.answers).toBeGreaterThan(0);
      expect(state.candidates).toBeGreaterThan(0);
      expect(state.nonHostCandidates).toBe(0);
      expect(state.relayRequests).toBe(0);
      expect(state.contentLeaks).toBe(0);
      if (options.requireSentMdns) {
        expect(state.sentMdnsCandidates, 'each real browser must send its own mDNS host candidate')
          .toBeGreaterThan(0);
      }
    }
    await expect(reader.locator('#relayrow')).toBeHidden();
    await sharer.locator('#stop').click();
    await expect(reader.locator('#panel')).toBeHidden({ timeout: 10_000 });
    await expect(reader.locator('#panel')).not.toContainText(TEXT);
    await expect(reader.locator('#filelist .filerow')).toHaveCount(0);
  } finally {
    const summarize = async (page?: Page) => page && !page.isClosed()
      ? peerSummary(page).catch(() => 'unavailable') : 'unavailable';
    try {
      await testInfo.attach('local-network-connection.json', {
        body: Buffer.from(JSON.stringify({
          scope: options.scope ?? 'separate browser processes on one runner',
          browserVersions, expectedVersions: options.expectedVersions,
          requireSentMdns: options.requireSentMdns ?? false,
          signalingCounts: { aggregate: 'sent and received frames, including SDP and trickle ICE',
            sent: 'outgoing frames only, including SDP and trickle ICE' },
          connectedPeers,
          sharer: { peers: await summarize(sharer), signaling: sharerSignaling },
          reader: { peers: await summarize(reader), signaling: readerSignaling },
        }, null, 2)),
        contentType: 'application/json',
      });
    } finally {
      await readerContext?.close().catch(() => {});
      await sharerContext?.close().catch(() => {});
    }
  }
}
